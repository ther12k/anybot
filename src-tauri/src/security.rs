use crate::models::{CommandSafetyResult, CommandSafetyTier};
use crate::policy::{load_policy, load_standing_grants_sync, Policy, COMPOUND_MARKERS};

/// Evaluate a shell command against the loaded policy and standing grants.
///
/// Decision order (deny-before-allow, OpenBot-style):
///   1. Dangerous deny patterns        → Dangerous (never auto-run)
///   2. deny_commands list             → Mutative (never auto-run, even if granted)
///   3. Compound/redirect syntax       → Mutative (never inherits a safe prefix)
///   4. Standing grant (exact match)   → Safe (explicit prior user consent)
///   5. Read-only allowlist            → Safe
///   6. Anything else                  → Mutative (approval required)
pub fn evaluate_with_policy(
    command: &str,
    policy: &Policy,
    grants: &[String],
) -> CommandSafetyResult {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();
    let out = |tier: CommandSafetyTier,
               requires_confirmation: bool,
               reason: &str,
               standing_grant: bool| {
        CommandSafetyResult {
            command: trimmed.to_string(),
            tier,
            requires_confirmation,
            reason: reason.to_string(),
            standing_grant,
        }
    };

    if trimmed.is_empty() {
        return out(
            CommandSafetyTier::Mutative,
            true,
            "Empty command.",
            false,
        );
    }

    // 1. Dangerous patterns — flagged, never auto-run.
    if policy.deny_patterns.iter().any(|p| lower.contains(p.to_lowercase().as_str())) {
        return out(
            CommandSafetyTier::Dangerous,
            true,
            "Matched a deny pattern for potentially catastrophic system destruction.",
            false,
        );
    }

    let first_word = lower.split_whitespace().next().unwrap_or("").to_string();

    // 2. Denied commands — approval always, grants cannot override.
    if policy.deny_commands.iter().any(|c| c.eq_ignore_ascii_case(&first_word)) {
        return out(
            CommandSafetyTier::Mutative,
            true,
            "Command is on the deny list; approval is always required.",
            false,
        );
    }

    // 3. Compound / redirected syntax — never inherits a safe prefix.
    if COMPOUND_MARKERS.iter().any(|m| lower.contains(m)) {
        return out(
            CommandSafetyTier::Mutative,
            true,
            "Compound or redirected shell syntax; approval required for the whole command.",
            false,
        );
    }

    // 4. Standing grant — the user previously chose "Always allow" for this
    // exact command. Deny rules above have already run, so a grant can never
    // override them.
    if grants.iter().any(|g| g.trim().eq_ignore_ascii_case(trimmed)) {
        return out(
            CommandSafetyTier::Safe,
            false,
            "Standing grant: you previously chose Always allow for this exact command.",
            true,
        );
    }

    // 5. Read-only allowlist.
    let matches_phrase = |phrase: &str| {
        let p = phrase.to_lowercase();
        lower == p || lower.starts_with(&format!("{p} "))
    };

    let is_read_only = if policy.allow_phrases.iter().any(|p| matches_phrase(p)) {
        true
    } else if first_word == "git" {
        let sub = lower
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        policy.git_read_only.iter().any(|s| s.eq(&sub))
    } else {
        policy.allow_read_only.iter().any(|c| c.eq(&first_word))
    };

    if is_read_only {
        return out(
            CommandSafetyTier::Safe,
            false,
            "Read-only inspection command.",
            false,
        );
    }

    // 6. Fail closed: unknown commands require approval.
    out(
        CommandSafetyTier::Mutative,
        true,
        "Command is not on the read-only allowlist; approval required.",
        false,
    )
}

/// Convenience wrapper used by the Tauri command: loads the current policy
/// file and standing grants, then evaluates. A corrupt policy file falls
/// back to empty allowlists (everything requires approval).
pub fn evaluate_command_safety(command: &str) -> CommandSafetyResult {
    evaluate_with_policy(command, &load_policy(), &load_standing_grants_sync())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy::default()
    }

    #[test]
    fn test_safe_commands() {
        for cmd in [
            "ls -la",
            "git status",
            "git log --oneline",
            "cat README.md",
            "grep -r foo .",
            "cargo check",
            "node -v",
            "pwd",
        ] {
            let res = evaluate_with_policy(cmd, &policy(), &[]);
            assert_eq!(res.tier, CommandSafetyTier::Safe, "expected safe: {cmd}");
            assert!(!res.requires_confirmation, "expected no approval: {cmd}");
            assert!(!res.standing_grant, "not a grant: {cmd}");
        }
    }

    #[test]
    fn test_compound_commands_require_approval() {
        for cmd in [
            "pwd && touch /tmp/anybot-proof",
            "ls; rm -rf .",
            "cat README.md > /tmp/out",
            "echo hi >> notes.txt",
            "ls | tee listing.txt",
        ] {
            let res = evaluate_with_policy(cmd, &policy(), &[]);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected mutative: {cmd}");
            assert!(res.requires_confirmation, "expected approval: {cmd}");
        }
    }

    #[test]
    fn test_mutative_commands() {
        for cmd in [
            "npm install",
            "rm file.txt",
            "find . -delete",
            "git commit -m test",
            "touch newfile",
            "mv a b",
        ] {
            let res = evaluate_with_policy(cmd, &policy(), &[]);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected mutative: {cmd}");
            assert!(res.requires_confirmation, "expected approval: {cmd}");
        }
    }

    #[test]
    fn test_dangerous_commands() {
        let res = evaluate_with_policy("rm -rf /", &policy(), &[]);
        assert_eq!(res.tier, CommandSafetyTier::Dangerous);
        assert!(res.requires_confirmation);
    }

    #[test]
    fn standing_grant_allows_exact_command() {
        let grants = vec!["cargo test".to_string(), "npm run build".to_string()];
        let res = evaluate_with_policy("cargo test", &policy(), &grants);
        assert_eq!(res.tier, CommandSafetyTier::Safe);
        assert!(!res.requires_confirmation);
        assert!(res.standing_grant);

        // Exact match only: arguments change it back to approval.
        let res = evaluate_with_policy("cargo test -- --nocapture", &policy(), &grants);
        assert!(res.requires_confirmation);
    }

    #[test]
    fn grants_cannot_override_deny_or_compound() {
        let grants = vec![
            "rm -rf /".to_string(),
            "sudo apt install x".to_string(),
            "cat a > b".to_string(),
        ];
        // Dangerous pattern still wins over the grant.
        let res = evaluate_with_policy("rm -rf /", &policy(), &grants);
        assert_eq!(res.tier, CommandSafetyTier::Dangerous);
        assert!(res.requires_confirmation);
        // Compound syntax still wins.
        let res = evaluate_with_policy("cat a > b", &policy(), &grants);
        assert!(res.requires_confirmation);
        // deny_commands also beat grants.
        let mut p = policy();
        p.deny_commands = vec!["sudo".to_string()];
        let res = evaluate_with_policy("sudo apt install x", &p, &grants);
        assert!(res.requires_confirmation);
        assert!(!res.standing_grant);
    }

    #[test]
    fn corrupt_policy_fails_closed() {
        // Empty allowlists simulate the corrupt-file fallback.
        let p = Policy {
            deny_patterns: Default::default(),
            deny_commands: vec![],
            allow_read_only: vec![],
            git_read_only: vec![],
            allow_phrases: vec![],
        };
        // Even plain `ls` requires approval under a failed policy load.
        let res = evaluate_with_policy("ls", &p, &[]);
        assert!(res.requires_confirmation);
        assert_eq!(res.tier, CommandSafetyTier::Mutative);
    }
}
