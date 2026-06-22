// Resumption tickets — Mac-authoritative (§2.4). The device stores only
// {ticketId, PSK, idleExp, absExp}; the Mac holds the full record + lifecycle.
// Single-use rotation: redeeming consumes a ticket and the Mac issues a fresh
// one of the SAME family; re-presenting a consumed ticket invalidates the whole
// family and forces a cold handshake (§2.3). In-memory: tickets are intentionally
// volatile — a daemon restart forces a cold (Face ID) reconnect, which is safe.

import { randomBytes } from "node:crypto";

const IDLE_MS = 24 * 60 * 60 * 1000; // sliding 24h
const ABS_MS = 7 * 24 * 60 * 60 * 1000; // hard 7d ceiling

// Capabilities a resumed session gets — read + low-risk ONLY, never high-risk
// (a stolen ticket must never reach RCE; §2.4, §3.4).
export const RESUME_CAPS = ["read", "lowrisk"] as const;

export interface TicketRecord {
  ticketId: Buffer;
  familyId: Buffer;
  psk: Buffer;
  devId: string;
  caps: string[];
  epoch: number;
  issuedAt: number;
  idleExp: number;
  absExp: number;
  familyOrigin: number;
  consumed: boolean;
}

// What the device persists (Keychain WhenUnlockedThisDeviceOnly, no biometric).
export interface ClientTicket {
  ticketId: string; // b64u(16)
  psk: string; // b64u(32)
  idleExp: number;
  absExp: number;
}

export type RedeemResult =
  | { ok: true; record: TicketRecord }
  | { ok: false; code: "TICKET_INVALID" | "TICKET_REUSE" };

const b64u = (b: Buffer): string => b.toString("base64url");

export class TicketStore {
  private readonly byId = new Map<string, TicketRecord>();

  private toClient(r: TicketRecord): ClientTicket {
    return { ticketId: b64u(r.ticketId), psk: b64u(r.psk), idleExp: r.idleExp, absExp: r.absExp };
  }

  // First ticket of a new family (issued after a cold handshake).
  issue(devId: string, now: number, epoch = 0): { record: TicketRecord; client: ClientTicket } {
    const familyId = randomBytes(16);
    const rec: TicketRecord = {
      ticketId: randomBytes(16), familyId, psk: randomBytes(32), devId,
      caps: [...RESUME_CAPS], epoch, issuedAt: now,
      idleExp: now + IDLE_MS, absExp: now + ABS_MS, familyOrigin: now, consumed: false,
    };
    this.byId.set(b64u(rec.ticketId), rec);
    return { record: rec, client: this.toClient(rec) };
  }

  // Redeem on RES-1. Consumes the presented ticket; a reused (consumed) ticket
  // burns the whole family. Returns the live record on success so the caller can
  // verify the binder and rotate.
  redeem(ticketIdB64u: string, now: number): RedeemResult {
    const rec = this.byId.get(ticketIdB64u);
    if (!rec) return { ok: false, code: "TICKET_INVALID" };
    if (rec.consumed) {
      this.invalidateFamily(rec.familyId);
      return { ok: false, code: "TICKET_REUSE" };
    }
    if (now > rec.idleExp || now > rec.absExp) {
      this.byId.delete(ticketIdB64u);
      return { ok: false, code: "TICKET_INVALID" };
    }
    rec.consumed = true;
    return { ok: true, record: rec };
  }

  // Rotate to a fresh ticket in the same family (sliding idle, fixed absolute).
  rotate(prev: TicketRecord, now: number): { record: TicketRecord; client: ClientTicket } {
    const rec: TicketRecord = {
      ticketId: randomBytes(16), familyId: prev.familyId, psk: randomBytes(32), devId: prev.devId,
      caps: prev.caps, epoch: prev.epoch, issuedAt: now,
      idleExp: now + IDLE_MS, absExp: prev.absExp, familyOrigin: prev.familyOrigin, consumed: false,
    };
    this.byId.set(b64u(rec.ticketId), rec);
    return { record: rec, client: this.toClient(rec) };
  }

  invalidateFamily(familyId: Buffer): void {
    const hex = familyId.toString("hex");
    for (const [id, r] of this.byId) if (r.familyId.toString("hex") === hex) this.byId.delete(id);
  }

  // Panic switch (design §3.4 / §4.6).
  invalidateAll(): void { this.byId.clear(); }

  invalidateDevice(devId: string): void {
    for (const [id, r] of this.byId) if (r.devId === devId) this.byId.delete(id);
  }
}
