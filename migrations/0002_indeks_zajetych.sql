-- Odczyty „zajętych foteli" (mapa sali odpytywana co kilka sekund, liczniki w repertuarze)
-- czytają przez ten indeks tylko zajęte wiersze seansu, a nie wszystkie 80 foteli.
CREATE INDEX seats_event_status_expires_idx ON seats (eventId, status, expiresAt);
