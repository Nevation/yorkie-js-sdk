/*
 * Copyright 2020 The Yorkie Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ActorID } from '@yorkie-js-sdk/src/document/time/actor_id';
import {
  Observer,
  Observable,
  createObservable,
  Unsubscribe,
  ErrorFn,
  CompleteFn,
  NextFn,
} from '@yorkie-js-sdk/src/util/observable';
import {
  ActivateClientRequest,
  DeactivateClientRequest,
  AttachDocumentRequest,
  DetachDocumentRequest,
  PushPullRequest,
  WatchDocumentsRequest,
  WatchDocumentsResponse,
  DocEventType,
} from '@yorkie-js-sdk/src/api/yorkie_pb';
import { converter } from '@yorkie-js-sdk/src/api/converter';
import { YorkieClient as RPCClient } from '@yorkie-js-sdk/src/api/yorkie_grpc_web_pb';
import { Code, YorkieError } from '@yorkie-js-sdk/src/util/error';
import { logger } from '@yorkie-js-sdk/src/util/logger';
import { uuid } from '@yorkie-js-sdk/src/util/uuid';
import { DocumentKey } from '@yorkie-js-sdk/src/document/key/document_key';
import { DocumentReplica } from '@yorkie-js-sdk/src/document/document';
import {
  AuthUnaryInterceptor,
  AuthStreamInterceptor,
} from '@yorkie-js-sdk/src/core/auth';

/**
 * `ClientStatus` is client status types
 * @public
 */
export enum ClientStatus {
  Deactivated = 'deactivated',
  Activated = 'activated',
}

/**
 * `StreamConnectionStatus` is stream connection status types
 * @public
 */
export enum StreamConnectionStatus {
  Connected = 'connected',
  Disconnected = 'disconnected',
}

/**
 * `DocumentSyncResultType` is document sync result types
 * @public
 */
export enum DocumentSyncResultType {
  Synced = 'synced',
  SyncFailed = 'sync-failed',
}

/**
 * `ClientEventType` is client event types
 * @public
 */
export enum ClientEventType {
  StatusChanged = 'status-changed',
  DocumentsChanged = 'documents-changed',
  PeersChanged = 'peers-changed',
  StreamConnectionStatusChanged = 'stream-connection-status-changed',
  DocumentSynced = 'document-synced',
}

/**
 * `ClientEvent` is an event that occurs in `Client`. It can be delivered using
 * `Client.subscribe()`.
 *
 * @internal
 */
export type ClientEvent =
  | StatusChangedEvent
  | DocumentsChangedEvent
  | PeersChangedEvent
  | StreamConnectionStatusChangedEvent
  | DocumentSyncedEvent;

/**
 * @internal
 */
export interface BaseClientEvent {
  type: ClientEventType;
}

/**
 * `StatusChangedEvent` is an event that occurs when the Client's state changes.
 *
 * @public
 */
export interface StatusChangedEvent extends BaseClientEvent {
  type: ClientEventType.StatusChanged;
  value: ClientStatus;
}

/**
 * `DocumentsChangedEvent` is an event that occurs when documents attached to
 * the client changes.
 *
 * @public
 */
export interface DocumentsChangedEvent extends BaseClientEvent {
  type: ClientEventType.DocumentsChanged;
  value: Array<DocumentKey>;
}

/**
 * `PeersChangedEvent` is an event that occurs when the states of another peers
 * of the attached documents changes.
 *
 * @public
 */
export interface PeersChangedEvent extends BaseClientEvent {
  type: ClientEventType.PeersChanged;
  value: { [docKey: string]: { [clientKey: string]: Metadata } };
}

/**
 * `StreamConnectionStatusChangedEvent` is an event that occurs when
 * the client's stream connection state changes.
 *
 * @public
 */
export interface StreamConnectionStatusChangedEvent extends BaseClientEvent {
  type: ClientEventType.StreamConnectionStatusChanged;
  value: StreamConnectionStatus;
}

/**
 * `DocumentSyncedEvent` is an event that occurs when documents
 * attached to the client are synced.
 */
export interface DocumentSyncedEvent extends BaseClientEvent {
  type: ClientEventType.DocumentSynced;
  value: DocumentSyncResultType;
}

interface Attachment {
  doc: DocumentReplica<unknown>;
  isRealtimeSync: boolean;
  peerClients?: Map<string, { [key: string]: string }>;
  remoteChangeEventReceived?: boolean;
}

/**
 * `Metadata` is custom metadata that can be defined in the client.
 *
 * @public
 */
export type Metadata = { [key: string]: string };

/**
 * `ClientOptions` are user-settable options used when defining clients.
 *
 * @public
 */
export interface ClientOptions {
  key?: string;
  metadata?: Metadata;
  token?: string;
  syncLoopDuration?: number;
  reconnectStreamDelay?: number;
}

const DefaultClientOptions = {
  syncLoopDuration: 50,
  reconnectStreamDelay: 1000,
};

/**
 * `Client` is a normal client that can communicate with the agent.
 * It has documents and sends changes of the documents in local
 * to the agent to synchronize with other replicas in remote.
 *
 * @public
 */
export class Client implements Observable<ClientEvent> {
  private id?: ActorID;
  private key: string;
  private metadata: Metadata;
  private status: ClientStatus;
  private attachmentMap: Map<string, Attachment>;
  private syncLoopDuration: number;
  private reconnectStreamDelay: number;

  private rpcClient: RPCClient;
  private watchLoopTimerID?: ReturnType<typeof setTimeout>;
  private remoteChangeEventStream?: any;
  private eventStream: Observable<ClientEvent>;
  private eventStreamObserver!: Observer<ClientEvent>;

  /** @hideconstructor */
  constructor(rpcAddr: string, opts?: ClientOptions) {
    opts = opts || DefaultClientOptions;

    this.key = opts.key ? opts.key : uuid();
    this.metadata = opts.metadata ? opts.metadata : {};
    this.status = ClientStatus.Deactivated;
    this.attachmentMap = new Map();
    this.syncLoopDuration =
      opts.syncLoopDuration || DefaultClientOptions.syncLoopDuration;
    this.reconnectStreamDelay =
      opts.reconnectStreamDelay || DefaultClientOptions.reconnectStreamDelay;

    let rpcOpts;
    if (opts.token) {
      rpcOpts = {
        unaryInterceptors: [new AuthUnaryInterceptor(opts.token)],
        streamInterceptors: [new AuthStreamInterceptor(opts.token)],
      };
    }

    this.rpcClient = new RPCClient(rpcAddr, null, rpcOpts);
    this.eventStream = createObservable<ClientEvent>((observer) => {
      this.eventStreamObserver = observer;
    });
  }

  /**
   * `ativate` activates this client. That is, it register itself to the agent
   * and receives a unique ID from the agent. The given ID is used to
   * distinguish different clients.
   */
  public activate(): Promise<void> {
    if (this.isActive()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const req = new ActivateClientRequest();
      req.setClientKey(this.key);

      this.rpcClient.activateClient(req, {}, (err, res) => {
        if (err) {
          logger.error(`[AC] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        this.id = converter.toHexString(res.getClientId_asU8());
        this.status = ClientStatus.Activated;
        this.runSyncLoop();
        this.runWatchLoop();

        this.eventStreamObserver.next({
          type: ClientEventType.StatusChanged,
          value: this.status,
        });

        logger.info(`[AC] c:"${this.getKey()}" activated, id:"${this.id}"`);
        resolve();
      });
    });
  }

  /**
   * `deactivate` deactivates this client.
   */
  public deactivate(): Promise<void> {
    if (this.status === ClientStatus.Deactivated) {
      return Promise.resolve();
    }

    if (this.remoteChangeEventStream) {
      this.remoteChangeEventStream.cancel();
      this.remoteChangeEventStream = undefined;
    }

    return new Promise((resolve, reject) => {
      const req = new DeactivateClientRequest();
      req.setClientId(converter.toUint8Array(this.id!));

      this.rpcClient.deactivateClient(req, {}, (err) => {
        if (err) {
          logger.error(`[DC] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        this.status = ClientStatus.Deactivated;
        this.eventStreamObserver.next({
          type: ClientEventType.StatusChanged,
          value: this.status,
        });

        logger.info(`[DC] c"${this.getKey()}" deactivated`);
        resolve();
      });
    });
  }

  /**
   * `attach` attaches the given document to this client. It tells the agent that
   * this client will synchronize the given document.
   */
  public attach(
    doc: DocumentReplica<unknown>,
    isManualSync?: boolean,
  ): Promise<DocumentReplica<unknown>> {
    if (!this.isActive()) {
      throw new YorkieError(Code.ClientNotActive, `${this.key} is not active`);
    }

    doc.setActor(this.id!);

    return new Promise((resolve, reject) => {
      const req = new AttachDocumentRequest();
      req.setClientId(converter.toUint8Array(this.id!));
      req.setChangePack(converter.toChangePack(doc.createChangePack()));

      this.rpcClient.attachDocument(req, {}, (err, res) => {
        if (err) {
          logger.error(`[AD] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        const pack = converter.fromChangePack(res.getChangePack()!);
        doc.applyChangePack(pack);

        this.attachmentMap.set(doc.getKey(), {
          doc,
          isRealtimeSync: !isManualSync,
          peerClients: new Map(),
        });
        this.runWatchLoop();

        logger.info(`[AD] c:"${this.getKey()}" attaches d:"${doc.getKey()}"`);
        resolve(doc);
      });
    });
  }

  /**
   * `detach` detaches the given document from this client. It tells the
   * agent that this client will no longer synchronize the given document.
   *
   * To collect garbage things like CRDT tombstones left on the document, all
   * the changes should be applied to other replicas before GC time. For this,
   * if the document is no longer used by this client, it should be detached.
   */
  public detach(
    doc: DocumentReplica<unknown>,
  ): Promise<DocumentReplica<unknown>> {
    if (!this.isActive()) {
      throw new YorkieError(Code.ClientNotActive, `${this.key} is not active`);
    }

    return new Promise((resolve, reject) => {
      const req = new DetachDocumentRequest();
      req.setClientId(converter.toUint8Array(this.id!));
      req.setChangePack(converter.toChangePack(doc.createChangePack()));

      this.rpcClient.detachDocument(req, {}, (err, res) => {
        if (err) {
          logger.error(`[DD] c:"${this.getKey()}" err :`, err);
          reject(err);
          return;
        }

        const pack = converter.fromChangePack(res.getChangePack()!);
        doc.applyChangePack(pack);

        if (this.attachmentMap.has(doc.getKey())) {
          this.attachmentMap.delete(doc.getKey());
        }
        this.runWatchLoop();

        logger.info(`[DD] c:"${this.getKey()}" detaches d:"${doc.getKey()}"`);
        resolve(doc);
      });
    });
  }

  /**
   * `sync` pushes local changes of the attached documents to the Agent and
   * receives changes of the remote replica from the agent then apply them to
   * local documents.
   */
  public sync(): Promise<DocumentReplica<unknown>[]> {
    const promises = [];
    for (const [, attachment] of this.attachmentMap) {
      promises.push(this.syncInternal(attachment.doc));
    }

    return Promise.all(promises)
      .then((docs) => {
        return docs;
      })
      .catch((err) => {
        this.eventStreamObserver.next({
          type: ClientEventType.DocumentSynced,
          value: DocumentSyncResultType.SyncFailed,
        });
        throw err;
      });
  }

  /**
   * `subscribe` subscribes to the given topics.
   */
  public subscribe(
    nextOrObserver: Observer<ClientEvent> | NextFn<ClientEvent>,
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe {
    return this.eventStream.subscribe(
      nextOrObserver as NextFn<ClientEvent>,
      error,
      complete,
    );
  }

  /**
   * `getID` returns a ActorID of client.
   */
  public getID(): string | undefined {
    return this.id;
  }

  /**
   * `getKey` returns a key of client.
   */
  public getKey(): string {
    return this.key;
  }

  /**
   * `isActive` checks if the client is active.
   */
  public isActive(): boolean {
    return this.status === ClientStatus.Activated;
  }

  /**
   * `getStatus` returns the status of this client.
   */
  public getStatus(): ClientStatus {
    return this.status;
  }

  /**
   * `getMetadata` returns the metadata of this client.
   */
  public getMetadata(): Metadata {
    return this.metadata;
  }

  private runSyncLoop(): void {
    const doLoop = (): void => {
      if (!this.isActive()) {
        logger.debug(`[SL] c:"${this.getKey()}" exit sync loop`);
        return;
      }

      const promises = [];
      for (const [, attachment] of this.attachmentMap) {
        if (
          attachment.isRealtimeSync &&
          (attachment.doc.hasLocalChanges() ||
            attachment.remoteChangeEventReceived)
        ) {
          attachment.remoteChangeEventReceived = false;
          promises.push(this.syncInternal(attachment.doc));
        }
      }

      Promise.all(promises)
        .then(() => {
          const syncLoopDuration = this.remoteChangeEventStream
            ? this.syncLoopDuration
            : this.reconnectStreamDelay;
          setTimeout(doLoop, syncLoopDuration);
        })
        .catch((err) => {
          logger.error(`[SL] c:"${this.getKey()}" sync failed:`, err);
          this.eventStreamObserver.next({
            type: ClientEventType.DocumentSynced,
            value: DocumentSyncResultType.SyncFailed,
          });
          setTimeout(doLoop, this.reconnectStreamDelay);
        });
    };

    logger.debug(`[SL] c:"${this.getKey()}" run sync loop`);
    doLoop();
  }

  private runWatchLoop(): void {
    const doLoop = (): void => {
      if (this.remoteChangeEventStream) {
        this.remoteChangeEventStream.cancel();
        this.remoteChangeEventStream = undefined;
      }

      if (this.watchLoopTimerID) {
        clearTimeout(this.watchLoopTimerID);
        this.watchLoopTimerID = undefined;
      }

      if (!this.isActive()) {
        logger.debug(`[WL] c:"${this.getKey()}" exit watch loop`);
        return;
      }

      const realtimeSyncDocKeys: Array<DocumentKey> = [];
      for (const [, attachment] of this.attachmentMap) {
        if (attachment.isRealtimeSync) {
          realtimeSyncDocKeys.push(attachment.doc.getDocumentKey());
        }
      }

      if (!realtimeSyncDocKeys.length) {
        logger.debug(`[WL] c:"${this.getKey()}" exit watch loop`);
        return;
      }

      const req = new WatchDocumentsRequest();
      req.setClient(converter.toClient(this.id!, this.metadata));
      req.setDocumentKeysList(converter.toDocumentKeys(realtimeSyncDocKeys));

      const onStreamDisconnect = () => {
        this.remoteChangeEventStream = undefined;
        this.watchLoopTimerID = setTimeout(doLoop, this.reconnectStreamDelay);
        this.eventStreamObserver.next({
          type: ClientEventType.StreamConnectionStatusChanged,
          value: StreamConnectionStatus.Disconnected,
        });
      };

      const stream = this.rpcClient.watchDocuments(req, {});
      stream.on('data', (resp: WatchDocumentsResponse) => {
        this.handleWatchDocumentsResponse(realtimeSyncDocKeys, resp);
      });
      stream.on('end', onStreamDisconnect);
      stream.on('error', onStreamDisconnect);
      this.remoteChangeEventStream = stream;

      logger.info(
        `[WD] c:"${this.getKey()}" watches d:"${realtimeSyncDocKeys.map((key) =>
          key.toIDString(),
        )}"`,
      );
    };

    logger.debug(`[WL] c:"${this.getKey()}" run watch loop`);

    doLoop();
  }

  private handleWatchDocumentsResponse(
    keys: Array<DocumentKey>,
    resp: WatchDocumentsResponse,
  ) {
    const getPeers = (
      peersMap: { [key: string]: { [key: string]: Metadata } },
      key: DocumentKey,
    ) => {
      const attachment = this.attachmentMap.get(key.toIDString());
      const peers: { [key: string]: Metadata } = {};
      for (const [key, value] of attachment!.peerClients!) {
        peers[key] = value;
      }
      peersMap[key.toIDString()] = peers;
      return peersMap;
    };

    if (resp.hasInitialization()) {
      const pbPeersMap = resp.getInitialization()!.getPeersMapByDocMap();
      pbPeersMap.forEach((pbPeers, docID) => {
        const attachment = this.attachmentMap.get(docID);
        for (const pbClient of pbPeers.getClientsList()) {
          attachment!.peerClients!.set(
            converter.toHexString(pbClient.getId_asU8()),
            converter.fromMetadataMap(pbClient.getMetadataMap()),
          );
        }
      });

      this.eventStreamObserver.next({
        type: ClientEventType.PeersChanged,
        value: keys.reduce(getPeers, {}),
      });
      return;
    }

    const pbWatchEvent = resp.getEvent();
    const respKeys = converter.fromDocumentKeys(
      pbWatchEvent!.getDocumentKeysList(),
    );
    for (const key of respKeys) {
      const attachment = this.attachmentMap.get(key.toIDString());
      switch (pbWatchEvent!.getType()) {
        case DocEventType.DOCUMENTS_WATCHED:
          attachment!.peerClients!.set(
            converter.toHexString(pbWatchEvent!.getPublisher()!.getId_asU8()),
            converter.fromMetadataMap(
              pbWatchEvent!.getPublisher()!.getMetadataMap(),
            ),
          );
          break;
        case DocEventType.DOCUMENTS_UNWATCHED:
          attachment!.peerClients!.delete(
            converter.toHexString(pbWatchEvent!.getPublisher()!.getId_asU8()),
          );
          break;
        case DocEventType.DOCUMENTS_CHANGED:
          attachment!.remoteChangeEventReceived = true;
          break;
      }
    }

    if (pbWatchEvent!.getType() === DocEventType.DOCUMENTS_CHANGED) {
      this.eventStreamObserver.next({
        type: ClientEventType.DocumentsChanged,
        value: respKeys,
      });
    } else if (
      pbWatchEvent!.getType() === DocEventType.DOCUMENTS_WATCHED ||
      pbWatchEvent!.getType() === DocEventType.DOCUMENTS_UNWATCHED
    ) {
      this.eventStreamObserver.next({
        type: ClientEventType.PeersChanged,
        value: respKeys.reduce(getPeers, {}),
      });
    }
  }

  private syncInternal(
    doc: DocumentReplica<unknown>,
  ): Promise<DocumentReplica<unknown>> {
    return new Promise((resolve, reject) => {
      const req = new PushPullRequest();
      req.setClientId(converter.toUint8Array(this.id!));
      const reqPack = doc.createChangePack();
      const localSize = reqPack.getChangeSize();
      req.setChangePack(converter.toChangePack(reqPack));

      let isRejected = false;
      this.rpcClient
        .pushPull(req, {}, (err, res) => {
          if (err) {
            logger.error(`[PP] c:"${this.getKey()}" err :`, err);

            isRejected = true;
            reject(err);
            return;
          }

          const respPack = converter.fromChangePack(res.getChangePack()!);
          doc.applyChangePack(respPack);
          this.eventStreamObserver.next({
            type: ClientEventType.DocumentSynced,
            value: DocumentSyncResultType.Synced,
          });

          const docKey = doc.getKey();
          const remoteSize = respPack.getChangeSize();
          logger.info(
            `[PP] c:"${this.getKey()}" sync d:"${docKey}", push:${localSize} pull:${remoteSize} cp:${respPack
              .getCheckpoint()
              .getAnnotatedString()}`,
          );
        })
        .on('end', () => {
          if (isRejected) {
            return;
          }
          resolve(doc);
        });
    });
  }
}
