mod audit;
pub mod commands;
pub mod models;
pub mod policy;
pub mod proposal;
mod reviewed_file;
pub mod security;
mod session_import;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            audit::init_notifications(app.handle());
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
            policy::record_rejection_audit,
            policy::record_delegation_audit,
            audit::verify_audit_log,
            audit::has_audit_recording_failure,
            proposal::create_write_proposal,
            proposal::create_shell_proposal,
            proposal::approve_proposal,
            proposal::reject_proposal,
            proposal::cancel_proposal,
            commands::agent_acp::detect_agent_clis,
            commands::agent_acp::run_acp_prompt,
            commands::agent_acp::kill_acp_session,
            session_import::list_zcode_sessions,
            session_import::read_zcode_session,
            workspace::get_workspace_registry,
            workspace::ensure_default_workspace,
            workspace::create_workspace,
            workspace::add_workspace_resource,
            workspace::remove_workspace_resource,
            workspace::install_bots,
            workspace::update_bot_tools,
            workspace::remove_bot,
            workspace::start_workspace_run,
            workspace::end_workspace_run,
            workspace::verify_workspace_delegate,
            commands::fs::workspace_read_file,
            commands::fs::workspace_list_directory,
            proposal::workspace_create_write_proposal,
            commands::fs::workspace_write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
