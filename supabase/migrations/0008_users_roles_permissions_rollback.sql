-- Rollback for 0008. NOT run automatically — run it by hand only if you are
-- going back to a release that has no users/roles. It removes ONLY the four
-- tables 0008 created (and so the roles, users, role assignments and overrides
-- you set up in them); it does not touch Team Members, releases, regression,
-- test data, reports or the audit log (the audit entries about user/role
-- changes stay in audit_log). Make a backup first if you may want them back.
--
-- Note: before rolling back, the previous release decides access from the
-- per-card flags (statisticsAccess / reportingAccess), which this release left
-- in the data untouched, so nobody has to be re-granted anything.

drop table if exists app_user_permission_overrides;
drop table if exists app_users;
drop table if exists app_role_permissions;
drop table if exists app_roles;
