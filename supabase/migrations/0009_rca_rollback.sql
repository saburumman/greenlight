-- Rolls back 0009_rca.sql. DESTRUCTIVE: deletes every RCA. Take a backup first.
drop table if exists rcas;
drop table if exists app_meta;
