// Stylus 2.4.13 delegates UserCSS parsing to a worker hosted by an extension page.
// Register its existing port bridge, so this manager can host that worker too.
self.webpackChunkStylus.push([
  ['novelweb-reading-client'],
  {},
  require => require(5619),
]);
