# Security Auditor Memory Index

- [terraform_audit_summary.md](terraform_audit_summary.md) - Summary of Terraform infrastructure security audit findings (2026-03-18)
- [patterns_testing_endpoint_gate.md](patterns_testing_endpoint_gate.md) - E2E sign-in/seed/reset gating (6-layer); updateSiteCredentialStatus is a flag-only public mutation NOT test-gated (flag-vs-storage divergence risk)
- [patterns_selector_options_admin_model.md](patterns_selector_options_admin_model.md) - SetSelector/selectorOptions = admin-only global taxonomy (no IDOR); requireAdmin IS the prod fail-closed gate; getSelectorSyncStatus is now admin-gated (was a finding, RESOLVED); residual = raw error text rendered from selectorSyncStatus.message
- [patterns_credential_op_lock.md](patterns_credential_op_lock.md) - Per-(userId,site) OCC lease lock serializing cred store/test/delete; lockToken server-only invariant, cross-user isolation, non-reentrancy, lease>worst-login (verified sound 2026-06-19)
- [patterns_public_function_guard_sweep.md](patterns_public_function_guard_sweep.md) - How to sweep convex/ for missing identity checks: full guard-helper inventory, the comment-match trap, the "inconsistent twin" defect shape, and the 3 legitimately-public functions
