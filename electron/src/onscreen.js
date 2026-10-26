// Where the pet should be if it ended up behind the taskbar or off the screen; null if it's fine.
// `bounds` is the pet window, `workArea` the screen minus the taskbar, `body` the drawn pet's half width and
// height, and `ground` how far the feet sit above the window's bottom edge.
function screenFix(bounds, workArea, body, ground) {
  const cx = bounds.x + bounds.width / 2;
  const bottom = bounds.y + bounds.height;
  const floor = workArea.y + workArea.height;
  const below = bottom > floor + 1;
  const above = bottom - ground - body.height < workArea.y - 1;
  const sideways = cx + body.halfWidth < workArea.x + 10 || cx - body.halfWidth > workArea.x + workArea.width - 10;
  if (!below && !above && !sideways) return null;
  const minX = workArea.x - (bounds.width / 2 - body.halfWidth);
  const maxX = workArea.x + workArea.width - (bounds.width / 2 + body.halfWidth);
  return { x: Math.min(Math.max(bounds.x, minX), maxX), bottom: Math.min(Math.max(bottom, workArea.y + ground + body.height), floor) };
}

module.exports = { screenFix };
