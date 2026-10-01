// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // WebKitGTK's accelerated (GPU) compositing needs a working EGL display,
  // which fails to initialize at all on some GPU/driver/compositor
  // combinations - observed on Fedora/Wayland as a blank window (only the
  // native menu bar renders; the WebView content area is empty) plus
  // "Could not create default EGL display: EGL_BAD_PARAMETER. Aborting..."
  // and the WebKitWebProcess subprocess crashing outright. Disabling the
  // DMA-BUF renderer alone (a narrower, WebKitGTK 2.42+-specific workaround)
  // was not sufficient here since EGL itself can't stand up on this system,
  // not just the DMA-BUF buffer-sharing path within it - so also disable
  // accelerated compositing entirely, which avoids needing EGL/GL at all and
  // falls back to software rendering. Both must be set before WebKit
  // initializes.
  #[cfg(target_os = "linux")]
  {
    for (name, value) in [
      ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
      ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
    ] {
      if std::env::var_os(name).is_none() {
        unsafe {
          std::env::set_var(name, value);
        }
      }
    }
  }

  app_lib::run();
}
