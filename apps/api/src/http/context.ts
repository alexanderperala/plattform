import type { FastifyRequest } from 'fastify';
import type { AuditCtx } from '../services/audit.js';
import type { Role } from '../domain/permissions.js';

export interface AdminSession {
  sessionId: string;
  adminId: string;
  email: string;
  name: string;
  role: Role;
  stage: 'mfa_pending' | 'mfa_enroll' | 'active';
  reauthAt: Date | null;
  expiresAt: Date;
  breakGlass: boolean;
  mfaEnrolled: boolean;
}
export interface CustomerSession {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminSession;
    customer?: CustomerSession;
    errCtx: { workspaceId?: string; userId?: string; adminId?: string };
  }
}

export function auditCtx(req: FastifyRequest): AuditCtx {
  return {
    admin: req.admin ? { id: req.admin.adminId, email: req.admin.email, role: req.admin.role } : undefined,
    requestId: req.id,
    ip: req.ip,
    breakGlass: req.admin?.breakGlass ?? false,
  };
}

export function clientInfo(req: FastifyRequest): { ip: string; userAgent: string } {
  return { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) };
}
