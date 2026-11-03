#pragma once

#include "esp_http_server.h"

namespace network {

/** Serve one immutable, public skill-preview artifact from cache or gateway. */
esp_err_t preview_proxy_handler(httpd_req_t *req);

}  // namespace network
