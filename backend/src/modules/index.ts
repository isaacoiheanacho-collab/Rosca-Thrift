export { default as authRoutes } from './auth/auth.routes';
export { default as usersRoutes } from './users/users.routes';

export {
  publicBranchesRouter,
  superAdminBranchesRouter,
  branchTrustAccountRouter,
} from './branches/branches.routes';

export {
  kycRouter,
  branchAdminKycRouter,
  superAdminKycRouter,
} from './kyc/kyc.routes';

export {
  tenantsRouter,
  branchAdminTenantsRouter,
  superAdminTenantsRouter,
} from './tenants/tenants.routes';

export {
  contributionsRouter,
  branchAdminContributionsRouter,
} from './contributions/contributions.routes';

export { default as receiptsRouter } from './receipts/receipts.routes';

export {
  branchAdminPoolAccountRouter,
  superAdminMaintenanceAccountRouter,
  superAdminBranchPoolAccountRouter,
} from './pool-accounts/pool-accounts.routes';