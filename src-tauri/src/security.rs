use crate::models::{CommandSafetyResult, CommandSafetyTier};
use crate::policy::{load_policy, load_standing_grants_sync, Policy, StandingGrant, COMPOUND_MARKERS};

/// Commands that are read-only *only* with no arguments. With arguments they
/// execute or reconfigure: `env touch x` runs a program, `hostname new-name`
/// renames the machine. Any argument → approval, fail closed.
const ZERO_ARG_READ_ONLY: &[&str] = &["env", "hostname"];

/// Evaluate a shell command against the loaded policy and standing grants.
///
/// Decision order (deny-before-allow, OpenBot-style):
///   1. Dangerous deny patterns        → Dangerous (never auto-run)
///   2. deny_commands list             → Mutative (never auto-run, even if granted)
///   3. Compound/redirect/background   → Mutative (never inherits a safe prefix)
///   4. Standing grant (exact + cwd)   → Safe (explicit prior user consent)
///   5. Read-only allowlist, with argument validation for forms that are
///      only sometimes read-only (git subcommands, zero-arg commands)
///   6. Anything else                  → Mutative (approval required)
pub fn evaluate_with_policy(
    command: &str,
    policy: &Policy,
    grants: &[StandingGrant],
    cwd: Option<&str>,
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

    let tokens: Vec<&str> = lower.split_whitespace().collect();
    let first_word = tokens.first().copied().unwrap_or("");

    // 2. Denied commands — approval always, grants cannot override.
    if policy.deny_commands.iter().any(|c| c.eq_ignore_ascii_case(first_word)) {
        return out(
            CommandSafetyTier::Mutative,
            true,
            "Command is on the deny list; approval is always required.",
            false,
        );
    }

    // 3. Compound / redirected / background syntax — never inherits a safe
    // prefix. A bare `&` is enough: `ls & touch x` runs the second command.
    if COMPOUND_MARKERS.iter().any(|m| lower.contains(m)) {
        return out(
            CommandSafetyTier::Mutative,
            true,
            "Compound, redirected, or background shell syntax; approval required for the whole command.",
            false,
        );
    }

    // 4. Standing grant — the user previously chose "Always allow" for this
    // exact command (case-sensitive) in this working directory. Deny rules
    // above have already run, so a grant can never override them.
    if grants.iter().any(|g| grant_matches(g, trimmed, cwd)) {
        return out(
            CommandSafetyTier::Safe,
            false,
            "Standing grant: you previously chose Always allow for this exact command.",
            true,
        );
    }

    // 5. Read-only allowlist, with argument validation.
    let is_read_only = if ZERO_ARG_READ_ONLY.contains(&first_word) {
        // `env` / `hostname` print when bare; with arguments they act.
        tokens.len() == 1
    } else if first_word == "git" {
        let sub = tokens.get(1).copied().unwrap_or("");
        policy.git_read_only.iter().any(|s| s.eq(sub))
            && git_subcommand_is_read_only(sub, &tokens[2..])
    } else {
        let matches_phrase = |phrase: &str| {
            let p = phrase.to_lowercase();
            lower == p || lower.starts_with(&format!("{p} "))
        };
        policy.allow_phrases.iter().any(|p| matches_phrase(p))
            || (policy.allow_read_only.iter().any(|c| c.eq(first_word))
                && command_args_are_safe(first_word, &tokens[1..]))
    };

    if is_read_only {
        return out(
            CommandSafetyTier::Safe,
            false,
            "Read-only inspection command (arguments validated).",
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

/// A case-sensitive exact command identity, optionally scoped to one working
/// directory. A scoped grant never matches an unknown cwd (fail closed).
fn grant_matches(grant: &StandingGrant, command: &str, cwd: Option<&str>) -> bool {
    let (grant_command, grant_cwd) = match grant {
        StandingGrant::Simple(c) => (c.trim(), None),
        StandingGrant::Scoped { command, cwd } => (command.trim(), cwd.as_deref()),
    };
    if grant_command != command.trim() {
        return false;
    }
    match (grant_cwd, cwd) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(g), Some(c)) => g == c,
    }
}

/// Argument validation for `git` subcommands that are in the read-only list.
/// Several are only read-only for *some* forms: `git branch -D x` deletes,
/// plain `git branch <name>` creates, `git remote remove` mutates, and
/// `git tag <name>` creates a tag. Unknown forms fail closed → approval.
fn git_subcommand_is_read_only(sub: &str, args: &[&str]) -> bool {
    match sub {
        // Listing-only flags. Anything else (incl. bare `git branch name`)
        // is branch creation, rename, copy, or deletion → approval.
        // With an explicit --list/-l, positional tokens are patterns.
        "branch" => {
            if args.iter().any(|a| *a == "--list" || *a == "-l") {
                return true;
            }
            const LIST_FLAGS: &[&str] = &[
                "-a", "-r", "-v", "-vv", "-q", "-i", "--all",
                "--remotes", "--show-current", "--merged", "--no-merged",
                "--color", "--no-color", "--column", "--no-column",
            ];
            args.iter().all(|a| {
                LIST_FLAGS.contains(a)
                    || a.starts_with("--sort=")
                    || a.starts_with("--format=")
                    || a.starts_with("--contains")
                    || a.starts_with("--no-contains")
                    || a.starts_with("--points-at")
            })
        }
        // Listing plus positional inspection subcommands; add/rename/remove/
        // set-url/prune and friends all mutate the repository config. A
        // leading -v/--verbose does NOT make the rest safe — `git remote -v
        // remove origin` still deletes — so the remaining args are validated
        // the same way.
        "remote" => match args.first().copied().unwrap_or("") {
            "" => true,
            "-v" | "--verbose" => git_subcommand_is_read_only("remote", &args[1..]),
            "show" | "get-url" => args.len() >= 2,
            _ => false,
        },
        // Listing/verification flags only. `git tag <name>` creates;
        // `git tag -d` deletes; `-a`/`-s`/`-m`/`-f` all mutate.
        // With an explicit -l/--list the positional tokens are patterns;
        // with -v/--verify they are tag names to verify. Both read-only.
        "tag" => {
            if args
                .iter()
                .any(|a| *a == "--list" || *a == "-l" || *a == "--verify" || *a == "-v")
            {
                return true;
            }
            const LIST_FLAGS: &[&str] = &[
                "-v", "--verify", "--contains", "--no-contains",
                "--merged", "--no-merged", "--points-at", "-i", "--color",
                "--no-color", "--column", "--no-column", "-e", "--omit-empty",
            ];
            args.iter().all(|a| {
                LIST_FLAGS.contains(a)
                    || a.starts_with("--sort=")
                    || a.starts_with("--format=")
                    || a.starts_with("-n")
            })
        }
        // Pure readers EXCEPT their file-writing flags: `git diff
        // --output=f` (and show's) writes a file. Unknown writing forms
        // fail closed below.
        "status" | "log" | "diff" | "show" | "describe" | "rev-parse"
        | "blame" | "shortlog" | "ls-files" => {
            !args.iter().any(|a| a.starts_with("--output"))
        }
        _ => false,
    }
}

/// Argument validation for name-allowlisted commands that have flags able
/// to execute helper programs or otherwise mutate. Anything unrecognised
/// here keeps the command read-only-safe; the goal is to catch the known
/// exec-shaped forms, and unknown forms still fail closed overall because
/// they must ALSO be on the name allowlist to be considered at all.
fn command_args_are_safe(first_word: &str, args: &[&str]) -> bool {
    match first_word {
        // `rg --pre <cmd>` runs <cmd> as a preprocessor on every file.
        "rg" => !args.iter().any(|a| {
            *a == "--pre" || a.starts_with("--pre=") || *a == "--pre-glob"
                || a.starts_with("--pre-glob=")
        }),
        // Everything else on the allowlist has no known exec-flags; the
        // compound/redirect checks have already run.
        _ => true,
    }
}

/// Convenience wrapper used by the Tauri command: loads the current policy
/// file and standing grants, then evaluates. A corrupt policy file falls
/// back to empty allowlists (everything requires approval).
pub fn evaluate_command_safety(command: &str, cwd: Option<&str>) -> CommandSafetyResult {
    evaluate_with_policy(command, &load_policy(), &load_standing_grants_sync(), cwd)
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
            "node -v",
            "pwd",
            "env",
            "hostname",
            "printenv HOME",
            "git branch -a",
            "git branch --list main",
            "git remote -v",
            "git remote show origin",
            "git remote get-url origin",
            "git tag",
            "git tag -l v1*",
            "git tag -v v1.0",
        ] {
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
            assert_eq!(res.tier, CommandSafetyTier::Safe, "expected safe: {cmd}");
            assert!(!res.requires_confirmation, "expected no approval: {cmd}");
            assert!(!res.standing_grant, "not a grant: {cmd}");
        }
    }

    #[test]
    fn zero_arg_read_only_rejects_arguments() {
        // `env` and `hostname` execute or reconfigure with arguments.
        for cmd in ["env touch example.txt", "env python -c x", "hostname new-name"] {
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected approval: {cmd}");
            assert!(res.requires_confirmation);
        }
    }

    #[test]
    fn git_mutative_forms_within_read_only_subcommands() {
        for cmd in [
            "git branch -D example",          // delete branch
            "git branch new-feature",         // create branch
            "git branch -m old new",          // rename
            "git remote remove origin",       // delete remote
            "git remote add up https://x",    // add remote
            "git remote prune origin",        // mutate tracking refs
            "git tag v1.0",                   // create tag
            "git tag -d v1.0",                // delete tag
            "git tag -a v1.0 -m msg",         // create annotated tag
        ] {
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected approval: {cmd}");
            assert!(res.requires_confirmation);
        }
    }

    #[test]
    fn background_operator_is_compound() {
        // Bare `&` backgrounds the first part and runs the rest: `ls & touch x`.
        let res = evaluate_with_policy("ls & touch example.txt", &policy(), &[], None);
        assert_eq!(res.tier, CommandSafetyTier::Mutative);
        assert!(res.requires_confirmation);
    }

    #[test]
    fn git_remote_verbose_does_not_whitelist_remove() {
        // `-v` first used to short-circuit the rest of the args.
        let res = evaluate_with_policy("git remote -v remove origin", &policy(), &[], None);
        assert_eq!(res.tier, CommandSafetyTier::Mutative);
        assert!(res.requires_confirmation);
        // Verbose listing stays safe.
        let res = evaluate_with_policy("git remote -v", &policy(), &[], None);
        assert_eq!(res.tier, CommandSafetyTier::Safe);
    }

    #[test]
    fn git_diff_output_flag_writes_a_file() {
        let res = evaluate_with_policy(
            "git diff --no-index --output=diff.txt a.txt b.txt",
            &policy(),
            &[],
            None,
        );
        assert_eq!(res.tier, CommandSafetyTier::Mutative);
        assert!(res.requires_confirmation);
        // Plain diff stays safe.
        let res = evaluate_with_policy("git diff --stat a.txt b.txt", &policy(), &[], None);
        assert_eq!(res.tier, CommandSafetyTier::Safe);
    }

    #[test]
    fn rg_preprocessor_flag_requires_approval() {
        for cmd in [
            "rg --pre=./preprocessor.sh pattern file",
            "rg --pre ./preprocessor.sh pattern file",
            "rg pattern --pre-glob='*.rs' file",
        ] {
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected approval: {cmd}");
            assert!(res.requires_confirmation);
        }
        // Ordinary rg stays safe.
        let res = evaluate_with_policy("rg -n pattern .", &policy(), &[], None);
        assert_eq!(res.tier, CommandSafetyTier::Safe);
    }

    #[test]
    fn build_script_runners_require_approval() {
        // cargo check/tree/metadata execute build scripts; npx can install
        // packages. Removed from the inert phrase list on purpose.
        for cmd in ["cargo check", "cargo tree", "npx tsc --noEmit"] {
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected approval: {cmd}");
            assert!(res.requires_confirmation);
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
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
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
            let res = evaluate_with_policy(cmd, &policy(), &[], None);
            assert_eq!(res.tier, CommandSafetyTier::Mutative, "expected mutative: {cmd}");
            assert!(res.requires_confirmation, "expected approval: {cmd}");
        }
    }

    #[test]
    fn test_dangerous_commands() {
        let res = evaluate_with_policy("rm -rf /", &policy(), &[], None);
        assert_eq!(res.tier, CommandSafetyTier::Dangerous);
        assert!(res.requires_confirmation);
    }

    #[test]
    fn standing_grant_allows_exact_command() {
        let grants = vec![
            StandingGrant::Simple("cargo test".to_string()),
            StandingGrant::Simple("npm run build".to_string()),
        ];
        let res = evaluate_with_policy("cargo test", &policy(), &grants, None);
        assert_eq!(res.tier, CommandSafetyTier::Safe);
        assert!(!res.requires_confirmation);
        assert!(res.standing_grant);

        // Exact match only: arguments change it back to approval.
        let res = evaluate_with_policy("cargo test -- --nocapture", &policy(), &grants, None);
        assert!(res.requires_confirmation);

        // Grants are case-sensitive command identities now.
        let res = evaluate_with_policy("CARGO TEST", &policy(), &grants, None);
        assert!(res.requires_confirmation);
    }

    #[test]
    fn scoped_grants_are_workspace_bound() {
        let grants = vec![StandingGrant::Scoped {
            command: "cargo test".to_string(),
            cwd: Some("/home/user/proj-a".to_string()),
        }];
        // Same cwd → granted.
        let res = evaluate_with_policy("cargo test", &policy(), &grants, Some("/home/user/proj-a"));
        assert!(res.standing_grant);
        // Different project → approval.
        let res = evaluate_with_policy("cargo test", &policy(), &grants, Some("/home/user/proj-b"));
        assert!(!res.standing_grant);
        assert!(res.requires_confirmation);
        // Unknown cwd → fail closed.
        let res = evaluate_with_policy("cargo test", &policy(), &grants, None);
        assert!(!res.standing_grant);
    }

    #[test]
    fn grants_cannot_override_deny_or_compound() {
        let grants = vec![
            StandingGrant::Simple("rm -rf /".to_string()),
            StandingGrant::Simple("sudo apt install x".to_string()),
            StandingGrant::Simple("cat a > b".to_string()),
        ];
        // Dangerous pattern still wins over the grant.
        let res = evaluate_with_policy("rm -rf /", &policy(), &grants, None);
        assert_eq!(res.tier, CommandSafetyTier::Dangerous);
        assert!(res.requires_confirmation);
        // Compound syntax still wins.
        let res = evaluate_with_policy("cat a > b", &policy(), &grants, None);
        assert!(res.requires_confirmation);
        // deny_commands also beat grants.
        let mut p = policy();
        p.deny_commands = vec!["sudo".to_string()];
        let res = evaluate_with_policy("sudo apt install x", &p, &grants, None);
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
        let res = evaluate_with_policy("ls", &p, &[], None);
        assert!(res.requires_confirmation);
        assert_eq!(res.tier, CommandSafetyTier::Mutative);
    }
}
