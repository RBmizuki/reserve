# Fixtures

HTML samples the parser tests run against, so the test suite never touches the
official site.

**These files are hand-written, not captured from the live site.** They are
modelled on the reservation site's documented, publicly indexed search-result
URLs (`/hotel/list/?...&searchHotelCD=DHM&...`) and on the `hotelRoomCd=...`
room links those pages contain.

To replace them with the real thing — which you should do the first time you
run this on a Mac that can reach the site:

```bash
npm run capture
```

That saves a **sanitised** copy (no cookies, no tokens, no form input) as
`captured-<timestamp>-<watch-id>-<transport>.html`, prints how the parser read
it, and those files can then be used as fixtures too.
