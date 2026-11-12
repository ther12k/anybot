use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ShellCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
    pub execution_time_ms: u128,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum CommandSafetyTier {
    Safe,
    Mutative,
    Dangerous,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandSafetyResult {
    pub command: String,
    pub tier: CommandSafetyTier,
    pub requires_confirmation: bool,
    pub reason: String,
    /// True when an exact standing grant ("Always allow") matched. Deny
    /// rules are checked first, so a grant never overrides them.
    pub standing_grant: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileReadResult {
    pub content: String,
    pub total_lines: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileWriteResult {
    pub path: String,
    pub success: bool,
    pub size_bytes: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub username: String,
    pub cwd: String,
    pub home_dir: String,
}
