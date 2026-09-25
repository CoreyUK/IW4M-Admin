# CUKServers webfront assets

Served by nginx from `/var/www/cukservers/`, not by IW4MAdmin, so they survive
image rebuilds. nginx injects them into every page with `sub_filter`:

```nginx
location = /js/cuk-webfront.js { alias /var/www/cukservers/cuk-webfront.js; }
location = /css/user/user.css  { alias /var/www/cukservers/user.css; }

sub_filter '</body>' '<script src="/js/cuk-webfront.js?Version=13"></script></body>';
sub_filter 'css/user/user.css?Version=' 'css/user/user.css?cukBadge=114&Version=';
```

Both URLs carry a version, and **browsers cache them hard** — bump `Version=`
for the script and `cukBadge=` for the stylesheet in
`nginx/conf.d/cukservers.net.conf` whenever either file changes, or players
keep the old copy.

`user.css` here is the real stylesheet. The one in
`WebfrontCore/wwwroot/css/user/user.css` is upstream's empty stub, which this
one shadows.

## What they do

`cuk-webfront.js` decorates pages IW4MAdmin has already rendered: it turns the
badge plugin's tiles into medal rows, picks category icons, and hides the Game
Statistics panel on a profile that has no multiplayer stats but does have
zombies ones, so the page is not left with a grid of zeros.

`user.css` styles those badge tiles and lets the zombie panels take a full row
of the profile grid.
