# dmgbuild settings for E.V.dmg (no Finder scripting: the layout is written directly).
import os

app = defines["app"]  # noqa: F821  (dmgbuild passes -D app=…)
art = defines["art"]  # noqa: F821
files = [app]
symlinks = {"Applications": "/Applications"}
icon_locations = {os.path.basename(app): (170, 190), "Applications": (490, 190)}
background = os.path.join(art, "background.png")
window_rect = ((200, 120), (660, 400))
icon_size = 112
text_size = 13
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
default_view = "icon-view"
format = "UDZO"
