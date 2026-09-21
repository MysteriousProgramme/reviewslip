-- Demo reviews, for looking at a dashboard that has been running a while.
--
--   psql "$DATABASE_URL" -v slug=baanpong -f scripts/seed-demo-reviews.sql
--
-- Two kinds, because the Reviews page shows two and they are not the same
-- thing. Reviews this product helped write, grouped by the listing the guest
-- took them to; and reviews already on those listings, which is what the world
-- wrote whether or not anybody helped.
--
-- Every row it writes is tagged, so undoing it is two statements:
--
--   DELETE FROM review_events    WHERE model = 'demo';
--   DELETE FROM external_reviews WHERE external_id LIKE 'demo/%';
--
-- Running it twice gives you one set, not two, on both halves.
--
-- It runs in a transaction and does not commit. Look at the counts it prints,
-- then COMMIT or ROLLBACK yourself. On a production database that is not
-- caution for its own sake: these rows are indistinguishable from real ones on
-- every screen, they move the usage counters the month is billed on, and the
-- tag is the only thing separating them.

\if :{?slug}
\else
  \set slug 'baanpong'
\endif

\set ON_ERROR_STOP on

BEGIN;

-- psql does not substitute variables inside a dollar-quoted body, so the slug
-- is handed over as a session setting instead.
SELECT set_config('demo.slug', :'slug', false);

/* --------------------------------------------- reviews written through us */

DO $$
DECLARE
  v_sub integer;
  r     record;
  n     integer := 0;
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

  -- Run twice and you get one set, not two. The listing half below is
  -- protected by its unique index; this half has nothing to collide on, so a
  -- second run quietly doubled every count on the dashboard — which is exactly
  -- the sort of thing somebody discovers a week later and cannot explain.
  IF EXISTS (
    SELECT 1 FROM review_events WHERE subscriber_id = v_sub AND model = 'demo'
  ) THEN
    RAISE NOTICE 'venue already has demo reviews — leaving them alone';
    RETURN;
  END IF;

  /*
   * Spread over ten weeks so the daily chart has a shape rather than a spike,
   * and weighted towards Google the way a real venue's are: most people have
   * one listing they actually push, and a dashboard where the four platforms
   * are evenly matched is a dashboard nobody has.
   *
   * A few have gone nowhere — proceeded_at NULL. Those are the ones the list
   * deliberately excludes and the "written and not used" line counts, and a
   * seed without them hides the one number on that page most likely to be
   * misread.
   */
  FOR r IN
    SELECT * FROM (VALUES
      ('google', 'The staff remembered our names by the second morning. Small thing, but it made the week.', 5, 'staff+welcome', 2),
      ('google', 'Clean, quiet, and the garden is genuinely lovely in the early evening.', 5, 'rooms+grounds', 4),
      ('google', 'Good value for the area. Breakfast could be quicker when it is busy.', NULL, 'food+value', 6),
      ('google', 'Easy check-in after a late flight, and someone waited up for us.', 4, 'staff+arrival', 9),
      ('google', 'Room was spotless. The bed is better than the one at home.', 5, 'rooms', 12),
      ('google', 'Lovely spot. Wifi dropped out a couple of times in the far room.', 3, 'rooms+facilities', 16),
      ('google', 'Second stay this year. Nothing has slipped, which is rarer than it should be.', 5, 'staff+rooms', 21),
      ('google', 'Friendly, relaxed, and the coffee is real coffee.', NULL, 'food+staff', 27),
      ('google', 'Quiet even though we were near the road. Slept properly for the first time all trip.', 4, 'rooms', 33),
      ('google', 'They arranged a car at six in the morning without being asked twice.', 5, 'staff', 40),
      ('google', 'Simple, comfortable, and the price is honest.', 4, 'value+rooms', 48),
      ('google', 'The garden is the reason to stay here. Breakfast under it is worth getting up for.', 5, 'grounds+food', 55),
      ('tripadvisor', 'Easy walk to the night market. Would stay again.', 4, 'location', 3),
      ('tripadvisor', 'Comfortable bed, thin walls. Bring earplugs and you will be fine.', NULL, 'rooms', 8),
      ('tripadvisor', 'Owners clearly care about the place. It shows in small things.', 5, 'staff', 14),
      ('tripadvisor', 'Good base for a few days. Nothing fancy, nothing wrong.', 3, 'value', 24),
      ('tripadvisor', 'The pool is small but it is never crowded.', 4, 'facilities', 37),
      ('facebook', 'Friendly people, sorted our late check-out without a fuss.', NULL, 'staff', 5),
      ('facebook', 'Lovely couple of nights. Thank you for the fruit.', 5, 'staff+food', 19),
      ('facebook', 'Handy for the ferry and they held our bags all afternoon.', 4, 'location+staff', 45),
      -- Written and never taken anywhere. These are the gap between the stat
      -- cards and the list, and the page says so out loud.
      (NULL, 'Lovely stay, thank you.', NULL, 'staff', 1),
      (NULL, 'Everything was fine. No complaints at all.', NULL, 'rooms', 7),
      (NULL, 'Really enjoyed it, will be back next year I hope.', NULL, 'staff+grounds', 22),
      (NULL, 'Good location, close to everything we wanted to see.', NULL, 'location', 31)
    ) AS t(platform, body, rating, topics, days_ago)
  LOOP
    INSERT INTO review_events
      (subscriber_id, review_text, category_id, rating, rated_at,
       language, length, model, prompt_tokens, completion_tokens, total_tokens,
       proceeded_at, proceeded_to, created_at)
    VALUES (
      v_sub,
      r.body,
      r.topics,
      r.rating,
      -- Rated a little after it was written, which is how it happens: somebody
      -- works through the list on a quiet afternoon, not at the moment a guest
      -- presses the button.
      CASE WHEN r.rating IS NOT NULL
           THEN now() - make_interval(days => r.days_ago) + interval '2 days'
      END,
      'en',
      CASE WHEN length(r.body) > 70 THEN 'detailed' ELSE 'any' END,
      -- The tag. Also the column that would hold the real model name, so a
      -- demo row is visibly a demo row wherever anyone looks.
      'demo',
      620, 95, 715,
      CASE WHEN r.platform IS NOT NULL
           THEN now() - make_interval(days => r.days_ago) + interval '3 minutes'
      END,
      r.platform,
      now() - make_interval(days => r.days_ago)
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'wrote % generated reviews', n;
END $$;

/* ------------------------------------------- reviews already on the listings */

DO $$
DECLARE
  v_sub integer;
  r     record;
  n     integer := 0;
  got   integer;
BEGIN
  SELECT id INTO v_sub FROM subscribers WHERE slug = current_setting('demo.slug');

  /*
   * Inside thirty days, because that is the window the page asks for, with one
   * deliberately outside it: a seed where everything is visible cannot show
   * that the window is doing anything.
   *
   * Two carry a reply, one of them answered on the platform itself — which is
   * the case the upsert protects, and the case worth seeing on the screen.
   */
  FOR r IN
    SELECT * FROM (VALUES
      ('google', 'demo/g-101', 'Anna L',  5, 'Lovely garden, and the breakfast fruit is all local.', 2, NULL, NULL),
      ('google', 'demo/g-102', 'Tom B',   2, 'Waited forty minutes for breakfast with a toddler in tow.', 6, NULL, NULL),
      ('google', 'demo/g-103', 'Kit R',   4, 'Good value. Room was warm at night.', 11, 10, 'Thank you — the fan in that room has been replaced.'),
      ('google', 'demo/g-104', 'Priya',   5, 'Second time here. Still the best value in town.', 19, NULL, NULL),
      ('google', 'demo/g-105', 'Marcus',  3, 'Fine, but the photos are flattering about the pool.', 26, NULL, NULL),
      ('google', 'demo/g-106', 'Su',      5, 'Nothing was too much trouble. Genuinely kind people.', 41, NULL, NULL),
      ('tripadvisor', 'demo/t-201', 'Mel',   3, 'Fine for a night. Thin walls.', 4, NULL, NULL),
      ('tripadvisor', 'demo/t-202', 'Jorge', 5, 'Owners could not have been kinder when our flight moved.', 14, 13, 'Thank you Jorge — glad it worked out in the end.'),
      ('tripadvisor', 'demo/t-203', 'Hana',  4, 'Quiet, clean, good breakfast. Would book again.', 23, NULL, NULL),
      ('facebook', 'demo/f-301', 'Dao S',  4, 'Booked last minute and they still had a room ready.', 8, NULL, NULL),
      ('facebook', 'demo/f-302', 'Ben',    1, 'Booking was lost and nobody could find it. Sorted eventually.', 17, NULL, NULL)
    ) AS t(platform, ext, author, rating, body, days_ago, replied_days_ago, reply)
  LOOP
    INSERT INTO external_reviews
      (subscriber_id, platform, external_id, author, rating, body,
       posted_at, replied_at, reply_body, url)
    VALUES (
      v_sub,
      r.platform,
      r.ext,
      r.author,
      r.rating,
      r.body,
      now() - make_interval(days => r.days_ago),
      CASE WHEN r.replied_days_ago IS NOT NULL
           THEN now() - make_interval(days => r.replied_days_ago)
      END,
      r.reply,
      NULL
    )
    -- The same promise the fetch makes, kept the same way: the unique index
    -- is on (subscriber, platform, external_id).
    ON CONFLICT (subscriber_id, platform, external_id) DO NOTHING;

    -- What landed, not what was offered. A second run that says "wrote 11"
    -- having written none is a script lying about its own behaviour on the
    -- one line somebody reads to check it.
    GET DIAGNOSTICS got = ROW_COUNT;
    n := n + got;
  END LOOP;

  RAISE NOTICE 'wrote % listing reviews', n;
END $$;

/* ------------------------------------------------------------------ counts */

\echo ''
\echo 'Generated reviews, by where the guest took them:'
SELECT coalesce(proceeded_to, '(nowhere)') AS listing,
       count(*),
       count(rating) AS rated
  FROM review_events
 WHERE model = 'demo'
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo 'Listing reviews, by listing — and how many are waiting for an answer:'
SELECT platform,
       count(*),
       count(*) FILTER (WHERE replied_at IS NULL) AS unanswered,
       count(*) FILTER (WHERE posted_at >= now() - interval '30 days') AS in_window
  FROM external_reviews
 WHERE external_id LIKE 'demo/%'
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo 'This must be 0 — a listing review stored twice:'
SELECT count(*) AS duplicated FROM (
  SELECT subscriber_id, platform, external_id
    FROM external_reviews
   GROUP BY 1, 2, 3 HAVING count(*) > 1
) x;

\echo ''
\echo 'Nothing is saved yet. COMMIT; to keep it, ROLLBACK; to throw it away.'
