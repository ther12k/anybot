// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Match the light Grok-style UI: force light GTK chrome (title bar)
  // so the window decoration doesn't follow a dark system theme.
  // Must be set before GTK initializes; safe here because we are
  // single-threaded at process start.
  if std::env::var("GTK_THEME").is_err() {
    unsafe {
      std::env::set_var("GTK_THEME", "Adwaita:light");
    }
  }
  app_lib::run();
}
