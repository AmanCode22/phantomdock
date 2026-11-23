//! Markdown-aware chunk splitter for chunked inline skill delivery.
//!
//! Splits cleanly on heading (`##`, `###`) or paragraph boundaries without ever
//! breaking fenced code blocks. Code fences are atomic: an oversized fence
//! becomes its own part rather than being split mid-block.

#[derive(Debug, Clone)]
pub struct Part {
    pub text: String,
    /// Heading titles contained in this part (for the section outline).
    pub outline: Vec<String>,
}

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
enum Kind {
    Heading,
    Paragraph,
    Code,
}

struct Block {
    kind: Kind,
    text: String,
    heading: Option<String>,
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

fn fence_marker(line: &str) -> &str {
    let t = line.trim_start();
    if t.starts_with("```") {
        "```"
    } else {
        "~~~"
    }
}

fn parse_blocks(content: &str) -> Vec<Block> {
    let lines: Vec<&str> = content.lines().collect();
    let mut blocks: Vec<Block> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim_start();
        if is_fence(line) {
            let marker = fence_marker(line);
            let mut j = i + 1;
            while j < lines.len() && !lines[j].trim_start().starts_with(marker) {
                j += 1;
            }
            let end = j.min(lines.len() - 1); // unterminated fence absorbs the rest
            blocks.push(Block {
                kind: Kind::Code,
                text: lines[i..=end].join("\n"),
                heading: None,
            });
            i = end + 1;
        } else if t.starts_with('#') {
            blocks.push(Block {
                kind: Kind::Heading,
                text: line.trim_end().to_string(),
                heading: Some(t.trim_start_matches('#').trim().to_string()),
            });
            i += 1;
        } else if t.is_empty() {
            i += 1;
        } else {
            let mut j = i;
            while j < lines.len() {
                let l = lines[j].trim_start();
                if l.is_empty() || l.starts_with('#') || is_fence(l) {
                    break;
                }
                j += 1;
            }
            blocks.push(Block {
                kind: Kind::Paragraph,
                text: lines[i..j].join("\n"),
                heading: None,
            });
            i = j;
        }
    }
    blocks
}

/// Split `content` into parts of at most ~`chunk_chars` characters.
///
/// Rules:
/// - Never split inside a fenced code block (fences are atomic).
/// - Prefer breaking before a heading once the current part is >= half full.
/// - A single block larger than `chunk_chars` becomes its own part.
pub fn split_markdown(content: &str, chunk_chars: usize) -> Vec<Part> {
    let chunk_chars = chunk_chars.max(200);
    let blocks = parse_blocks(content);
    let mut parts: Vec<Part> = Vec::new();
    let mut cur: Vec<Block> = Vec::new();
    let mut cur_len = 0usize;

    fn flush(cur: &mut Vec<Block>, parts: &mut Vec<Part>) {
        if cur.is_empty() {
            return;
        }
        let text = cur
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let outline = cur.iter().filter_map(|b| b.heading.clone()).collect();
        parts.push(Part { text, outline });
        cur.clear();
    }

    for b in blocks {
        let bl = b.text.chars().count();
        if cur.is_empty() {
            cur.push(b);
            cur_len = bl;
            continue;
        }
        let prefer_break_at_heading = b.kind == Kind::Heading && cur_len >= chunk_chars / 2;
        let would_overflow = cur_len + bl > chunk_chars;
        if prefer_break_at_heading || would_overflow {
            flush(&mut cur, &mut parts);
            cur_len = 0;
        }
        cur_len += bl;
        cur.push(b);
    }
    flush(&mut cur, &mut parts);
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn well_formed() -> String {
        let mut s = String::from("# Grill Me\n\nIntro paragraph.\n\n");
        s.push_str("## Rules\n\nRule one.\n\nRule two.\n\n");
        s.push_str("```\ncode block line 1\ncode block line 2\n```\n\n");
        s.push_str("## Decision Tree\n\nAsk questions.\n\nThen more questions.\n");
        s
    }

    #[test]
    fn parts_are_nonempty_and_within_budget() {
        let parts = split_markdown(&well_formed(), 120);
        assert!(!parts.is_empty());
        for p in &parts {
            assert!(!p.text.trim().is_empty());
            // Paragraph-level blocks stay under budget; only atomic code fences may exceed.
            let fence_lines = p.text.lines().any(|l| l.trim_start().starts_with("```"));
            if !fence_lines {
                assert!(
                    p.text.chars().count() <= 120,
                    "part too big: {}",
                    p.text.len()
                );
            }
        }
    }

    #[test]
    fn round_trip_joins_to_original() {
        let original = well_formed();
        let parts = split_markdown(&original, 100);
        let rejoined = parts
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        // `lines()` drops the trailing newline; compare against the trimmed original.
        assert_eq!(rejoined, original.trim_end_matches('\n'));
    }

    #[test]
    fn code_fences_never_split() {
        let mut s = String::from("## Section\n\n");
        for i in 0..30 {
            s.push_str(&format!("```\nblock {i}\nline a\nline b\n```\n\n"));
        }
        let parts = split_markdown(&s, 300);
        assert!(parts.len() > 1);
        for p in &parts {
            let open = p
                .text
                .lines()
                .filter(|l| l.trim_start().starts_with("```"))
                .count();
            assert_eq!(open % 2, 0, "unbalanced fences in part: {}", p.text);
        }
    }

    #[test]
    fn oversized_fence_becomes_own_part() {
        let mut s = String::from("# Title\n\n");
        s.push_str("```\n");
        for i in 0..500 {
            s.push_str(&format!("huge code line {i}\n"));
        }
        s.push_str("```\n\n## After\n\nTail.\n");
        let parts = split_markdown(&s, 400);
        let fence_part = parts
            .iter()
            .find(|p| p.text.contains("huge code line"))
            .expect("fence part present");
        assert!(fence_part.text.chars().count() > 400); // atomic, not split
        assert!(fence_part.text.starts_with("```"));
        assert!(fence_part.text.trim_end().ends_with("```"));
    }

    #[test]
    fn outline_collects_headings_per_part() {
        let parts = split_markdown(&well_formed(), 80);
        let all: Vec<String> = parts.iter().flat_map(|p| p.outline.clone()).collect();
        assert_eq!(all, vec!["Grill Me", "Rules", "Decision Tree"]);
    }

    #[test]
    fn prefers_breaking_before_headings() {
        // Long paragraph followed by a heading: break should land before the heading
        // when the paragraph already fills >= half the budget.
        let mut s = String::new();
        s.push_str(&format!("{}\n\n", "filler ".repeat(40))); // ~280 chars
        s.push_str("## Next Section\n\nshort\n");
        let parts = split_markdown(&s, 500);
        assert_eq!(parts.len(), 2);
        assert!(!parts[0].text.contains("## Next Section"));
        assert!(parts[0].outline.is_empty());
        assert_eq!(parts[1].outline, vec!["Next Section".to_string()]);
    }

    #[test]
    fn tiny_content_single_part() {
        let parts = split_markdown("# Hi\n\nBody.\n", 6000);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].outline, vec!["Hi".to_string()]);
    }
}
