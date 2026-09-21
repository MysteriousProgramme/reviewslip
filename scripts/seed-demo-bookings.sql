-- Demo bookings, for looking at a busy calendar.
--
--   psql "$DATABASE_URL" -v slug=baanpong -f scripts/seed-demo-bookings.sql
--
-- Every row it writes is tagged `source = 'demo'`, so undoing it is one
-- statement:
--
--   DELETE FROM bookings WHERE source = 'demo';
--
-- room_nights.booking_id cascades, so the nights go with them.
--
-- It runs in a transaction and does not commit. Look at the counts it prints,
-- then COMMIT or ROLLBACK yourself. On a production database that is not
-- caution for its own sake: this writes several hundred rows that are
-- indistinguishable from real bookings on every screen, and the tag is the
-- only thing separating them.
--
-- Rooms are created too, if the venue has fewer than eight — a calendar with
-- three rooms cannot show what a full one looks like, which is the point.

\if :{?slug}
\else
  \set slug 'baanpong'
\endif

\set ON_ERROR_STOP on

BEGIN;

-- psql does not substitute variables inside a dollar-quoted body, so the slug
-- is handed over as a session setting instead.
SELECT set_config('demo.slug', :'slug', false);

/* ------------------------------------------------------------------ rooms */

DO $$
DECLARE
  v_sub integer;
  v_grp integer;
  v_has integer;
  g     record;
  i     integer;
BEGIN
  SELECT id INTO v_sub FROM subscribers WHERE slug = current_setting('demo.slug');
  IF v_sub IS NULL THEN
    -- With the list, because the slug is the one thing somebody running this
    -- has to guess, and a bare refusal leaves them at an aborted transaction
    -- with no way forward that does not involve another query.
    RAISE EXCEPTION 'No venue with slug %. Venues here: %',
      current_setting('demo.slug'),
      coalesce(
        (SELECT string_agg(slug, ', ' ORDER BY id) FROM subscribers),
        '(none — this database has no venues)'
      );
  END IF;

  SELECT count(*) INTO v_has FROM rooms WHERE subscriber_id = v_sub;
  IF v_has >= 8 THEN
    RAISE NOTICE 'venue already has % rooms — leaving them alone', v_has;
    RETURN;
  END IF;

  FOR g IN
    SELECT * FROM (VALUES
      ('Garden Bungalow', 2, 8, 'G'),
      ('Family Suite',    4, 5, 'F'),
      ('Loft',            2, 6, 'L'),
      ('Riverside Villa', 6, 4, 'R')
    ) AS t(name, capacity, rooms, prefix)
  LOOP
    INSERT INTO room_groups (subscriber_id, name, capacity)
    VALUES (v_sub, g.name, g.capacity)
    ON CONFLICT (subscriber_id, lower(name)) DO NOTHING;

    SELECT id INTO v_grp FROM room_groups
     WHERE subscriber_id = v_sub AND lower(name) = lower(g.name);

    FOR i IN 1..g.rooms LOOP
      INSERT INTO rooms (subscriber_id, group_id, name, sort)
      VALUES (v_sub, v_grp, g.prefix || lpad(i::text, 2, '0'), i)
      ON CONFLICT (subscriber_id, lower(name)) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

/* --------------------------------------------------------------- bookings */

DO $$
DECLARE
  -- Tune these three.
  v_back  integer := 45;      -- days of history
  v_ahead integer := 75;      -- days of future
  v_fill  numeric := 0.72;    -- 0..1, roughly how full

  v_sub    integer;
  v_from   date;
  v_to     date;
  r        record;
  v_day    date;
  v_len    integer;
  v_id     integer;
  v_status text;
  v_holds  boolean;
  v_made   integer := 0;
  v_past   integer := 0;
  i        integer;

  firsts text[] := ARRAY['Anna','Tom','Priya','Wei','Somchai','Maria','Jonas','Yuki',
                         'Alexander','Fatima','Diego','Nadia','Ravi','Ingrid','Kwame',
                         'Elena','Hiroshi','Amara','Lukas','Chen'];
  lasts  text[] := ARRAY['Lindqvist','Becker','Raman','Zhang','Preecha','Oduya','Meyer',
                         'Tanaka','Sterling','Haddad','Alvarez','Petrova','Kapoor',
                         'Berg','Mensah','Rossi','Yamada','Okafor','Novak','Lim'];
BEGIN
  SELECT id INTO v_sub FROM subscribers WHERE slug = current_setting('demo.slug');
  v_from := current_date - v_back;
  v_to   := current_date + v_ahead;

  /*
   * One room at a time, walking forward.
   *
   * Placing stays back to back down a single room keeps the demo stays from
   * overlapping each other: a room cannot clash with itself if the next stay
   * starts after the last one ended.
   *
   * That says nothing about what is already in the room. This gets run on a
   * venue that is already taking bookings at least as often as on an empty
   * one, and room_nights has a UNIQUE (room_id, night) that a real guest may
   * already be holding — so every span is checked before it is used, and the
   * ones that are taken are stepped over. Assuming an empty calendar is what
   * made this fail on the first venue it met that was not one.
   */
  FOR r IN
    SELECT id, group_id FROM rooms
     WHERE subscriber_id = v_sub AND status = 'active'
     ORDER BY id
  LOOP
    v_day := v_from + floor(random() * 5)::int;

    WHILE v_day < v_to LOOP
      v_len := 1 + floor(random() * 7)::int;          -- 1 to 7 nights
      EXIT WHEN v_day + v_len >= v_to;

      -- The status follows the dates, the way a real one would.
      IF v_day + v_len <= current_date THEN
        v_status := CASE WHEN random() < 0.08 THEN 'no_show' ELSE 'checked_out' END;
      ELSIF v_day <= current_date THEN
        v_status := 'in_house';
      ELSE
        v_status := CASE WHEN random() < 0.06 THEN 'cancelled' ELSE 'confirmed' END;
      END IF;

      -- Only three statuses take inventory, so only those can clash.
      v_holds := v_status IN ('confirmed', 'in_house', 'checked_out');

      IF v_holds AND EXISTS (
        SELECT 1 FROM room_nights n
         WHERE n.room_id = r.id
           AND n.night >= v_day
           AND n.night <  v_day + v_len
      ) THEN
        -- Somebody real is in that room. Step past the span and carry on
        -- rather than giving up on the room: a venue with one busy week would
        -- otherwise end up with a demo calendar missing whole rooms.
        v_past := v_past + 1;
        v_day  := v_day + v_len + 1;
        CONTINUE;
      END IF;

      INSERT INTO bookings
        (subscriber_id, group_id, room_id, guest_name, guest_email,
         adults, children, arrival, departure, status, source)
      VALUES
        (v_sub, r.group_id, r.id,
         firsts[1 + floor(random() * array_length(firsts, 1))::int] || ' ' ||
         lasts[1 + floor(random() * array_length(lasts, 1))::int],
         'demo' || floor(random() * 100000)::int || '@example.test',
         1 + floor(random() * 3)::int,
         CASE WHEN random() < 0.25 THEN 1 + floor(random() * 2)::int ELSE 0 END,
         v_day, v_day + v_len, v_status, 'demo')
      RETURNING id INTO v_id;

      /*
       * Only the statuses that hold a room get nights.
       *
       * A cancellation gives its inventory back immediately — that is what
       * HOLDS_INVENTORY means in bookings.js — so writing nights for one here
       * would both overstate occupancy and occupy an index slot that a real
       * stay is entitled to.
       */
      IF v_holds THEN
        INSERT INTO room_nights (subscriber_id, room_id, night, booking_id)
        SELECT v_sub, r.id, d::date, v_id
          FROM generate_series(v_day, v_day + (v_len - 1), interval '1 day') AS d;
      END IF;

      v_made := v_made + 1;

      -- The empty nights before the next stay. A higher fill means shorter gaps.
      v_day := v_day + v_len + 1 + floor(random() * (12 * (1 - v_fill)))::int;
    END LOOP;
  END LOOP;

  -- A dozen with no room at all, for the marigold bars and the line above the
  -- month that counts them.
  FOR i IN 1..12 LOOP
    INSERT INTO bookings
      (subscriber_id, group_id, room_id, guest_name, guest_email,
       adults, arrival, departure, status, source)
    SELECT v_sub, g.id, NULL,
           firsts[1 + floor(random() * array_length(firsts, 1))::int] || ' ' ||
           lasts[1 + floor(random() * array_length(lasts, 1))::int],
           'demo' || floor(random() * 100000)::int || '@example.test',
           2,
           current_date + floor(random() * 40)::int,
           current_date + floor(random() * 40)::int + 1 + floor(random() * 5)::int,
           'confirmed', 'demo'
      FROM room_groups g
     WHERE g.subscriber_id = v_sub
     ORDER BY random()
     LIMIT 1;
  END LOOP;

  RAISE NOTICE 'wrote % bookings', v_made;
  IF v_past > 0 THEN
    RAISE NOTICE 'stepped over % span% already taken by real bookings',
      v_past, CASE WHEN v_past = 1 THEN '' ELSE 's' END;
  END IF;
END $$;

/* ----------------------------------------------------------------- checks */

\echo ''
\echo 'By status:'
SELECT status, count(*) FROM bookings WHERE source = 'demo'
 GROUP BY status ORDER BY 2 DESC;

\echo ''
\echo 'Occupancy for the next fortnight:'
SELECT n.night,
       count(*) AS sold,
       (SELECT count(*) FROM rooms r
         WHERE r.subscriber_id = n.subscriber_id AND r.status = 'active') AS rooms
  FROM room_nights n
 WHERE n.subscriber_id = (SELECT id FROM subscribers WHERE slug = current_setting('demo.slug'))
   AND n.night BETWEEN current_date AND current_date + 13
 GROUP BY n.night, n.subscriber_id
 ORDER BY n.night;

\echo ''
\echo 'Both of these must be 0 — a room double-booked, and a cancelled stay still holding nights:'
SELECT
  (SELECT count(*) FROM (
     SELECT room_id, night FROM room_nights GROUP BY 1, 2 HAVING count(*) > 1
   ) x) AS double_booked,
  (SELECT count(*) FROM room_nights n
     JOIN bookings b ON b.id = n.booking_id
    WHERE b.status IN ('cancelled', 'no_show')) AS ghost_nights;

\echo ''
\echo 'Nothing is saved yet. COMMIT; to keep it, ROLLBACK; to throw it away.'
