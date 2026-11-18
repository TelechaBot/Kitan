-- Kitan no longer holds or removes direct joiners on their profile (the admins opened that
-- door), so appeals are again only for lifting a mute with the ordinary check.
DROP INDEX appeals_holds;
ALTER TABLE appeals DROP COLUMN kick_at;
ALTER TABLE appeals DROP COLUMN kicked_at;
ALTER TABLE appeals DROP COLUMN challenge;
