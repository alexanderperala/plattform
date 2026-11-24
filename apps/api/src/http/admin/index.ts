import type { FastifyInstance } from 'fastify';
import { enforceDeclaredAccess } from './guard.js';
import { authRoutes } from './auth.js';
import { dashboardRoutes } from './dashboard.js';
import { workspaceRoutes } from './workspaces.js';
import { userRoutes } from './users.js';
import { entitlementRoutes } from './entitlements.js';
import { supportRoutes } from './support.js';
import { supportAccessRoutes } from './supportAccess.js';
import { approvalRoutes } from './approvals.js';
import { auditRoutes } from './audit.js';
import { adminManagementRoutes } from './admins.js';
import { configRoutes } from './config.js';

/** Superadmin-API. Allt här skyddas av guard och kräver deklarerad åtkomst per rutt. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  enforceDeclaredAccess(app);
  authRoutes(app);
  dashboardRoutes(app);
  workspaceRoutes(app);
  userRoutes(app);
  entitlementRoutes(app);
  supportRoutes(app);
  supportAccessRoutes(app);
  approvalRoutes(app);
  auditRoutes(app);
  adminManagementRoutes(app);
  configRoutes(app);
}
