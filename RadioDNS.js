// Plugin configuration, this is used in the administration when plugins are loaded
var pluginConfig = {
    name: 'RadioDNS Monitor',
    version: '1.0.0',
    author: 'fmdx.ie',
    frontEndPath: 'RadioDNS/pluginRadioDNS.js'
}

// Backend (server) changes can go here...
require('./RadioDNS/pluginRadioDNS_server.js');

// Don't change anything below here if you are making your own plugin
module.exports = {
    pluginConfig
}
