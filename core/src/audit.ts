/** Audit log, event feed and in-process event subscriptions (used by WebSockets). */
import {
  appendAudit,
  appendEvent,
  listAudit,
  listEvents,
  type AuditEntry,
  type EventEntry,
} from './db.ts';
import { id } from './util.ts';

type Listener = (event: EventEntry) => void;
const listeners = new Set<Listener>();

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishEvent(event: EventEntry): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must not break the audit trail */
    }
  }
}

/** Accepts an HTTP request, a principal, or a plain actor object. */
export type AuditSource =
  | {
      principal?: { user?: { id?: string; username?: string } };
      user?: { id?: string; username?: string };
      ip?: string;
      method?: string;
      path?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
    }
  | Record<string, unknown>
  | null;

function actorOf(source: AuditSource): string {
  if (!source || typeof source !== 'object') return 'system';
  const s = source as Record<string, any>;
  const user = s.principal?.user ?? s.user ?? s.principal;
  if (user && typeof user === 'object') {
    if (typeof user.username === 'string') return user.username;
    if (typeof user.id === 'string') return user.id;
  }
  if (typeof s.actor === 'string') return s.actor;
  return 'system';
}

function ipOf(source: AuditSource): string {
  if (!source || typeof source !== 'object') return '';
  const s = source as Record<string, any>;
  if (typeof s.ip === 'string') return s.ip;
  const forwarded = s.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (typeof s.socket?.remoteAddress === 'string') return s.socket.remoteAddress;
  return '';
}

/** Append one audit row plus one event row. Every mutating request goes here. */
export function record(
  source: AuditSource,
  action: string,
  resource: string,
  result: string = 'success',
  details: Record<string, unknown> = {},
): { audit: AuditEntry; event: EventEntry } {
  const actor = actorOf(source);
  const ip = ipOf(source);
  const resourceText = typeof resource === 'string' ? resource : JSON.stringify(resource);
  const message = `${action} on ${resourceText} ${result}`;
  const audit = appendAudit({
    id: id(),
    actor,
    action,
    resource: resourceText,
    result,
    ip,
    message,
    data: details,
  });
  const event = appendEvent({
    id: id(),
    level: result === 'failure' || result === 'error' ? 'error' : 'info',
    message,
    data: { action, resource: resourceText, actor, ip, result },
  });
  publishEvent(event);
  return { audit, event };
}

/** For service-level changes that are not directly tied to an HTTP request. */
export function recordSystem(
  action: string,
  resource: string,
  result = 'success',
  details: Record<string, unknown> = {},
): void {
  record(null, action, resource, result, details);
}

/** Fire an informational event without an audit row. */
export function emit(level: string, message: string, data: Record<string, unknown> = {}): EventEntry {
  const event = appendEvent({ id: id(), level, message, data });
  publishEvent(event);
  return event;
}

export function getEvents(limit = 100): EventEntry[] {
  return listEvents(limit);
}

export function getAudit(limit = 100): AuditEntry[] {
  return listAudit(limit);
}
