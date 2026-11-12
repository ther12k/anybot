pub mod commands;
pub mod models;
pub mod policy;
pub mod proposal;
pub mod security;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::shell::check_shell_safety,
            commands::shell::execute_shell_command,
            commands::shell::kill_shell_command,
            commands::fs::read_file_content,
            commands::fs::write_file_content,
            commands::fs::list_dir_entries,
            commands::fs::get_system_info,
            commands::vault::load_vault_config,
            commands::vault::save_vault_config,
            policy::load_standing_grants,
            policy::save_standing_grants,
            policy::audit_event,
            proposal::create_write_proposal,
            proposal::create_shell_proposal,
            proposal::approve_proposal,
            proposal::reject_proposal,
            proposal::cancel_proposal,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
