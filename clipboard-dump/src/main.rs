use clipboard_win::raw::{self, EnumFormats};

fn main() {
    match raw::open() {
        Ok(()) => {
            println!("=== ClipBoard Format Dump ===");
            println!("Formats count: {}", raw::count_formats().unwrap_or(0));

            let enum_formats = EnumFormats::new();
            let mut count = 0;
            for fmt in enum_formats {
                count += 1;
                println!("  Format 0x{:04X} ({})", fmt, fmt);
            }
            println!("Total: {} formats", count);

            // Check specific known formats
            println!("\n=== Format Checks ===");
            for &fmt in &[1u32, 13, 15, 16, 17] {
                if raw::is_format_avail(fmt) {
                    let s = raw::size(fmt).map(|n| n.get()).unwrap_or(0);
                    println!("  AVAIL: format {} (0x{:04X}), size={}", fmt, fmt, s);
                }
            }

            // Check registered formats
            for fmt in (0xC000u32..0xC020).chain(0xC100..0xC110) {
                if raw::is_format_avail(fmt) {
                    let s = raw::size(fmt).map(|n| n.get()).unwrap_or(0);
                    println!("  AVAIL REG: 0x{:04X}, size={}", fmt, s);
                }
            }

            // Try to read file list
            println!("\n=== File List (raw::get_file_list) ===");
            let mut files: Vec<String> = Vec::new();
            match raw::get_file_list(&mut files) {
                Ok(count) if count > 0 => {
                    println!("SUCCESS: {} files", count);
                    for f in &files { println!("  File: {}", f); }
                }
                Ok(_) => println!("0 files"),
                Err(e) => println!("Error: {}", e),
            }

            let _ = raw::close();
        }
        Err(e) => println!("FAIL: raw::open error - {}", e),
    }
}
