/**
 * A transport moves opaque, already sealed messages between peers in one
 * room. Transports never see keys or plaintext. See docs/PROTOCOL.md,
 * "Transports".
 */
export interface Transport {
  /** True if peers are other devices (WebRTC), false for other tabs on this device. */
  readonly remote: boolean;
  /** Sends to one peer, or to every connected peer when `peerId` is omitted. */
  send(data: Uint8Array, peerId?: string): void;
  close(): void;
}

export interface TransportEvents {
  onMessage(data: Uint8Array, peerId: string): void;
  onPeerJoin(peerId: string): void;
  onPeerLeave(peerId: string): void;
}

export interface RoomInfo {
  roomId: string;
  signalPassword: string;
}

export type TransportFactory = (room: RoomInfo, events: TransportEvents) => Transport;

/** Normalises the binary payload types transports may deliver. Returns null for anything else. */
export function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
