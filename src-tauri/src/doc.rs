//! Documents for the agent: reading PDFs, images, Word / PowerPoint / Excel / Pages / Keynote /
//! Numbers files the way a person would (the words, a picture of every page, and the text inside
//! pictures), and making PDF and Word documents from HTML. PDF and image work runs in the Swift
//! part of libgideoncapture.dylib (PDFKit, ImageIO, Vision); office files are zip archives read
//! with the system's `unzip`, and `textutil` converts Word-style formats.

use crate::shell_env::expand_tilde;
use serde::Serialize;
use serde_json::Value;
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Pages read per call by default, and the most one call may ask for.
const DEFAULT_PAGES: usize = 20;
const MAX_PAGES: usize = 50;
/// Page pictures per call: enough to check a document, few enough for any model's request size.
const MAX_PICTURES: usize = 8;
const PICTURE_PX: f64 = 1400.0;
const MAX_TEXT_CHARS: usize = 120_000;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocPage {
    pub number: usize,
    pub text: String,
    /// Words recognized in the page's picture (scans, screenshots, photos of notes).
    pub ocr: String,
    /// JPEG, base64.
    pub image: String,
    /// Share of the page that's empty at the bottom (only measured when a picture is drawn).
    pub blank: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocRead {
    pub path: String,
    /// pdf · image · word · slides · sheet
    pub kind: String,
    pub page_count: usize,
    /// For pages, slides and images inside the file.
    pub pages: Vec<DocPage>,
    /// Whole-document text (Word, spreadsheets) when it isn't split into pages.
    pub text: String,
    pub note: String,
}

// ── The Swift library ─────────────────────────────────────────────────────────

type InfoFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type PageFn = unsafe extern "C" fn(*const c_char, i32, f64, *const c_char, i32) -> *mut c_char;
type ImageFn = unsafe extern "C" fn(*const c_char, f64, *const c_char, i32) -> *mut c_char;
type FreeFn = unsafe extern "C" fn(*mut c_char);

struct Lib {
    info: InfoFn,
    page: PageFn,
    image: ImageFn,
    free: FreeFn,
}

pub(crate) fn lib_path() -> Option<PathBuf> {
    let bundled = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("../Resources/libgideoncapture.dylib")));
    // Development builds and tests use the copy in the source tree (release builds never carry that path).
    #[cfg(any(debug_assertions, test))]
    {
        let source = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/libgideoncapture.dylib"));
        return bundled.filter(|p| p.exists()).or_else(|| source.exists().then_some(source));
    }
    #[cfg(not(any(debug_assertions, test)))]
    bundled.filter(|p| p.exists())
}

fn lib() -> Result<&'static Lib, String> {
    static LIB: std::sync::OnceLock<Option<Lib>> = std::sync::OnceLock::new();
    LIB.get_or_init(|| {
        let path = CString::new(lib_path()?.display().to_string()).ok()?;
        let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return None;
        }
        let sym = |name: &CStr| {
            let p = unsafe { libc::dlsym(handle, name.as_ptr()) };
            (!p.is_null()).then_some(p as usize)
        };
        let (info, page, image, free) = (sym(c"gideon_pdf_info")?, sym(c"gideon_pdf_page")?, sym(c"gideon_image_jpeg")?, sym(c"gideon_free_string")?);
        Some(unsafe {
            Lib {
                info: std::mem::transmute::<usize, InfoFn>(info),
                page: std::mem::transmute::<usize, PageFn>(page),
                image: std::mem::transmute::<usize, ImageFn>(image),
                free: std::mem::transmute::<usize, FreeFn>(free),
            }
        })
    })
    .as_ref()
    .ok_or_else(|| "E.V's document reader is missing (libgideoncapture.dylib) — reinstall E.V".to_string())
}

fn take_json(lib: &Lib, raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("the document reader returned nothing".into());
    }
    let text = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { (lib.free)(raw) };
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    match value.get("error").and_then(Value::as_str) {
        Some(err) => Err(err.to_string()),
        None => Ok(value),
    }
}

fn c(path: &Path) -> Result<CString, String> {
    CString::new(path.display().to_string()).map_err(|_| "bad path".to_string())
}

/// A temporary folder removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("gideon-doc-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn read_jpeg(path: &Path) -> String {
    std::fs::read(path).map(|bytes| crate::mac_control::base64_encode(&bytes)).unwrap_or_default()
}

fn pdf_page_count(path: &Path) -> Result<usize, String> {
    let lib = lib()?;
    let p = c(path)?;
    let info = take_json(lib, unsafe { (lib.info)(p.as_ptr()) })?;
    if info.get("locked").and_then(Value::as_bool) == Some(true) {
        return Err("this PDF is password-protected".into());
    }
    Ok(info.get("pages").and_then(Value::as_u64).unwrap_or(0) as usize)
}

fn pdf_page(path: &Path, index: usize, picture: Option<&Path>, ocr: bool) -> Result<DocPage, String> {
    let lib = lib()?;
    let p = c(path)?;
    let out = CString::new(picture.map(|p| p.display().to_string()).unwrap_or_default()).map_err(|_| "bad path")?;
    let value = take_json(lib, unsafe { (lib.page)(p.as_ptr(), index as i32, PICTURE_PX, out.as_ptr(), ocr as i32) })?;
    Ok(DocPage {
        number: index + 1,
        text: value.get("text").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        ocr: value.get("ocr").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        image: picture.map(read_jpeg).unwrap_or_default(),
        blank: value.get("blank").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

fn image_page(path: &Path, number: usize, scratch: &Path, ocr: bool) -> Result<DocPage, String> {
    let lib = lib()?;
    let p = c(path)?;
    let jpeg = scratch.join(format!("image-{number}.jpg"));
    let out = c(&jpeg)?;
    let value = take_json(lib, unsafe { (lib.image)(p.as_ptr(), PICTURE_PX, out.as_ptr(), ocr as i32) })?;
    Ok(DocPage {
        number,
        text: String::new(),
        ocr: value.get("ocr").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        image: read_jpeg(&jpeg),
        blank: 0.0,
    })
}

/// Whether text read from a page's picture says something its text layer doesn't (words inside
/// screenshots, scans, diagrams) — otherwise it's a duplicate and left out.
pub fn adds_words(text: &str, ocr: &str) -> bool {
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_lowercase).collect()
    };
    let known: std::collections::HashSet<String> = words(text).into_iter().collect();
    let found = words(ocr);
    let new = found.iter().filter(|w| !known.contains(*w)).count();
    // A page with almost no text layer is a picture: anything read from it counts.
    if known.len() < 3 {
        return new >= 2;
    }
    new >= 6 && new * 4 >= found.len()
}

/// "3", "2-5", "1,4,7-9" → 0-based indexes (sorted, unique, capped).
pub fn parse_pages(spec: &str, count: usize) -> Result<Vec<usize>, String> {
    let mut out = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part, part),
        };
        let start: usize = a.parse().map_err(|_| format!("pages \"{spec}\" isn't a page range like \"3\" or \"2-5\""))?;
        let end: usize = if b.is_empty() { count } else { b.parse().map_err(|_| format!("pages \"{spec}\" isn't a page range like \"3\" or \"2-5\""))? };
        if start == 0 || start > count {
            return Err(format!("page {start} doesn't exist (the document has {count})"));
        }
        for page in start..=end.min(count) {
            out.push(page - 1);
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.len() > MAX_PAGES {
        return Err(format!("that's {} pages — ask for at most {MAX_PAGES} at a time", out.len()));
    }
    Ok(out)
}

fn read_pdf(path: &Path, pages: Option<&str>, pictures: bool) -> Result<DocRead, String> {
    let count = pdf_page_count(path)?;
    let wanted = match pages {
        Some(spec) if !spec.trim().is_empty() => parse_pages(spec, count)?,
        _ => (0..count.min(DEFAULT_PAGES)).collect(),
    };
    let scratch = Scratch::new()?;
    let mut out = DocRead { path: path.display().to_string(), kind: "pdf".into(), page_count: count, ..Default::default() };
    // Every page is also read with OCR (screenshots and scans hold words the text layer lacks);
    // pages run a few at a time since drawing and recognizing is the slow part.
    let results: Vec<Result<DocPage, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = wanted
            .chunks(wanted.len().div_ceil(4).max(1))
            .enumerate()
            .map(|(chunk, indexes)| {
                let first = chunk * wanted.len().div_ceil(4).max(1);
                let dir = &scratch.0;
                scope.spawn(move || {
                    indexes
                        .iter()
                        .enumerate()
                        .map(|(j, &index)| {
                            let jpeg = dir.join(format!("page-{}.jpg", index + 1));
                            let with_picture = pictures && first + j < MAX_PICTURES;
                            let mut page = pdf_page(path, index, with_picture.then_some(jpeg.as_path()), false)?;
                            let ocr = pdf_page(path, index, None, true)?.ocr;
                            page.ocr = if adds_words(&page.text, &ocr) { ocr } else { String::new() };
                            Ok(page)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_else(|_| vec![Err("the document reader crashed".into())])).collect()
    });
    for page in results {
        out.pages.push(page?);
    }
    let mut notes = Vec::new();
    if let (Some(first), Some(last)) = (wanted.first(), wanted.last()) {
        if wanted.len() < count {
            notes.push(format!("Read pages {}–{} of {count}. Ask for more with pages, e.g. \"{}-{}\".", first + 1, last + 1, last + 2, (last + 1 + DEFAULT_PAGES).min(count)));
        }
    }
    if pictures && wanted.len() > MAX_PICTURES {
        let shown: Vec<_> = wanted.iter().take(MAX_PICTURES).map(|i| i + 1).collect();
        notes.push(format!(
            "Pictures are attached for pages {}–{} only ({MAX_PICTURES} per call); read later pages with pages=\"{}-{}\" to see them.",
            shown[0],
            shown[shown.len() - 1],
            wanted[MAX_PICTURES] + 1,
            wanted[(MAX_PICTURES * 2 - 1).min(wanted.len() - 1)] + 1
        ));
    }
    out.note = notes.join(" ");
    Ok(out)
}

fn unzip_list(path: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("/usr/bin/unzip").arg("-Z1").arg(path).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a readable Office/iWork file".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect())
}

fn unzip_text(path: &Path, entry: &str) -> String {
    Command::new("/usr/bin/unzip")
        .arg("-p")
        .arg(path)
        .arg(entry)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn unzip_to(path: &Path, entry: &str, dir: &Path) -> Option<PathBuf> {
    let out = Command::new("/usr/bin/unzip").arg("-o").arg("-j").arg(path).arg(entry).arg("-d").arg(dir).output().ok()?;
    let file = dir.join(entry.rsplit('/').next()?);
    (out.status.success() && file.exists()).then_some(file)
}

/// The number inside names like "ppt/slides/slide12.xml".
fn trailing_number(name: &str) -> usize {
    let stem = name.rsplit('/').next().unwrap_or(name);
    stem.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)
}

fn xml_unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// Text of an Office XML part: paragraphs (`</a:p>`, `</w:p>`) become lines, tabs and breaks kept.
pub fn office_xml_text(xml: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        out.push_str(&xml_unescape(&rest[..start]));
        let Some(end) = rest[start..].find('>') else { break };
        let tag = &rest[start + 1..start + end];
        let name = tag.trim_start_matches('/').split([' ', '/']).next().unwrap_or("");
        if (tag.starts_with('/') && (name == "a:p" || name == "w:p")) || name == "a:br" || name == "w:br" {
            out.push('\n');
        } else if name == "w:tab" || name == "a:tab" {
            out.push('\t');
        }
        rest = &rest[start + end + 1..];
    }
    out.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

/// Attribute value inside one tag's text, e.g. `r="B3"`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=\"");
    let start = tag.find(&key)? + key.len();
    Some(tag[start..start + tag[start..].find('"')?].to_string())
}

/// Cells of one worksheet as tab-separated rows (shared strings resolved).
pub fn sheet_rows(xml: &str, shared: &[String]) -> String {
    let mut rows = Vec::new();
    for row in xml.split("<row").skip(1) {
        let row = row.split("</row>").next().unwrap_or("");
        let mut cells = Vec::new();
        for cell in row.split("<c ").skip(1) {
            let head = &cell[..cell.find('>').unwrap_or(cell.len())];
            let kind = attr(&format!(" {head}"), "t").unwrap_or_default();
            let value = if kind == "inlineStr" {
                office_xml_text(cell[(head.len() + 1).min(cell.len())..].split("</is>").next().unwrap_or(""))
            } else {
                let raw = cell.split("<v>").nth(1).and_then(|v| v.split("</v>").next()).unwrap_or("");
                if kind == "s" {
                    raw.parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_default()
                } else {
                    xml_unescape(raw)
                }
            };
            cells.push(value.replace(['\t', '\n'], " "));
        }
        while cells.last().is_some_and(|c| c.is_empty()) {
            cells.pop();
        }
        if !cells.is_empty() {
            rows.push(cells.join("\t"));
        }
    }
    rows.join("\n")
}

/// Pictures embedded in an Office file (media folder), each with the words read from it.
fn embedded_pictures(path: &Path, entries: &[String], folder: &str, scratch: &Path, limit: usize) -> Vec<DocPage> {
    let images: Vec<&String> = entries
        .iter()
        .filter(|e| e.starts_with(folder) && [".png", ".jpg", ".jpeg", ".gif", ".tif", ".tiff", ".bmp", ".heic", ".webp"].iter().any(|x| e.to_lowercase().ends_with(x)))
        .collect();
    images
        .into_iter()
        .take(limit)
        .enumerate()
        .filter_map(|(i, entry)| {
            let file = unzip_to(path, entry, scratch)?;
            image_page(&file, i + 1, scratch, true).ok()
        })
        .collect()
}

fn read_office(path: &Path, ext: &str, pictures: bool) -> Result<DocRead, String> {
    let entries = unzip_list(path)?;
    let scratch = Scratch::new()?;
    let mut out = DocRead { path: path.display().to_string(), ..Default::default() };
    // iWork files carry a preview of the whole document.
    if ["pages", "key", "numbers"].contains(&ext) {
        if let Some(preview) = entries.iter().find(|e| e.eq_ignore_ascii_case("QuickLook/Preview.pdf")) {
            let file = unzip_to(path, preview, &scratch.0).ok_or("couldn't open the document's preview")?;
            let mut doc = read_pdf(&file, None, pictures)?;
            doc.path = out.path;
            doc.note = format!("Read from the file's built-in preview. {}", doc.note).trim().to_string();
            return Ok(doc);
        }
        if let Some(thumb) = entries.iter().find(|e| e.to_lowercase().starts_with("preview") && e.to_lowercase().ends_with(".jpg")) {
            let file = unzip_to(path, thumb, &scratch.0).ok_or("couldn't open the document's preview")?;
            out.kind = "image".into();
            out.pages.push(image_page(&file, 1, &scratch.0, true)?);
            out.page_count = 1;
            out.note = "This iWork file only has a small preview picture; export it to PDF in its app for the full content.".into();
            return Ok(out);
        }
        return Err("this iWork file has no preview inside; open it in its app and export a PDF".into());
    }
    match ext {
        "pptx" => {
            out.kind = "slides".into();
            let mut slides: Vec<&String> = entries.iter().filter(|e| e.starts_with("ppt/slides/slide") && e.ends_with(".xml")).collect();
            slides.sort_by_key(|e| trailing_number(e));
            out.page_count = slides.len();
            for slide in &slides {
                let number = trailing_number(slide);
                let notes = entries.iter().find(|e| *e == &format!("ppt/notesSlides/notesSlide{number}.xml")).map(|n| office_xml_text(&unzip_text(path, n))).unwrap_or_default();
                let mut text = office_xml_text(&unzip_text(path, slide));
                if !notes.trim().is_empty() {
                    text.push_str(&format!("\n[Speaker notes] {}", notes.replace('\n', " ")));
                }
                out.pages.push(DocPage { number, text, ..Default::default() });
            }
            if pictures {
                let pics = embedded_pictures(path, &entries, "ppt/media/", &scratch.0, MAX_PICTURES);
                if !pics.is_empty() {
                    out.note = format!("{} picture(s) from the slides are attached in order of the file, with their words.", pics.len());
                    out.pages.extend(pics.into_iter().map(|mut p| {
                        p.number = 0;
                        p
                    }));
                }
            }
        }
        "xlsx" => {
            out.kind = "sheet".into();
            let shared_xml = unzip_text(path, "xl/sharedStrings.xml");
            let shared: Vec<String> = shared_xml.split("<si>").skip(1).map(|si| office_xml_text(si.split("</si>").next().unwrap_or("")).replace('\n', " ")).collect();
            let workbook = unzip_text(path, "xl/workbook.xml");
            let names: Vec<String> = workbook.split("<sheet ").skip(1).filter_map(|s| attr(&format!(" {s}"), "name").map(|n| xml_unescape(&n))).collect();
            let mut sheets: Vec<&String> = entries.iter().filter(|e| e.starts_with("xl/worksheets/sheet") && e.ends_with(".xml")).collect();
            sheets.sort_by_key(|e| trailing_number(e));
            out.page_count = sheets.len();
            let mut text = String::new();
            for (i, sheet) in sheets.iter().enumerate() {
                let name = names.get(i).cloned().unwrap_or_else(|| format!("Sheet {}", i + 1));
                text.push_str(&format!("## {name}\n{}\n\n", sheet_rows(&unzip_text(path, sheet), &shared)));
            }
            out.text = text.trim().to_string();
            out.note = "Values as last saved (formulas show their results).".into();
        }
        _ => {
            // docx / odt: the words via textutil, then the pictures inside.
            out.kind = "word".into();
            out.text = textutil_text(path)?;
            out.page_count = 1;
            if pictures {
                let folder = if ext == "odt" { "Pictures/" } else { "word/media/" };
                let pics = embedded_pictures(path, &entries, folder, &scratch.0, MAX_PICTURES);
                if !pics.is_empty() {
                    out.note = format!("{} picture(s) inside the document are attached, with the words read from them.", pics.len());
                    out.pages = pics;
                }
            }
        }
    }
    Ok(out)
}

fn textutil_text(path: &Path) -> Result<String, String> {
    let out = Command::new("/usr/bin/textutil").args(["-convert", "txt", "-stdout"]).arg(path).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("couldn't read the document: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "heic", "heif", "tif", "tiff", "bmp", "webp"];

/// What kind of document a path is, by extension (None: read it as plain text).
pub fn document_kind(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => Some("pdf"),
        e if IMAGE_EXTS.contains(&e) => Some("image"),
        "docx" | "odt" | "pptx" | "xlsx" | "pages" | "key" | "numbers" => Some("office"),
        "doc" | "rtf" | "rtfd" | "wordml" | "webarchive" => Some("word"),
        _ => None,
    }
}

fn clip_text(doc: &mut DocRead) {
    let total: usize = doc.text.len() + doc.pages.iter().map(|p| p.text.len() + p.ocr.len()).sum::<usize>();
    if total > MAX_TEXT_CHARS {
        if doc.text.len() > MAX_TEXT_CHARS {
            let cut: String = doc.text.chars().take(MAX_TEXT_CHARS).collect();
            doc.text = format!("{cut}\n…[the rest is longer than one read; ask for less]");
        }
        doc.note = format!("{} Very long — some text may be cut; read fewer pages at a time.", doc.note).trim().to_string();
    }
}

/// Reads a document: PDF (pages 1-based, e.g. "1-10"), image, or Office / iWork file.
pub fn read_document(path: &Path, pages: Option<&str>, pictures: bool) -> Result<DocRead, String> {
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }
    let name = path.display().to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut doc = match document_kind(&name) {
        Some("pdf") => read_pdf(path, pages, pictures)?,
        Some("image") => {
            let scratch = Scratch::new()?;
            let page = image_page(path, 1, &scratch.0, true)?;
            DocRead { path: name, kind: "image".into(), page_count: 1, pages: vec![page], ..Default::default() }
        }
        Some("office") => read_office(path, &ext, pictures)?,
        Some("word") => DocRead { path: name, kind: "word".into(), page_count: 1, text: textutil_text(path)?, ..Default::default() },
        _ => return Err("not a document type E.V reads as pages (read it as text instead)".into()),
    };
    if !pictures {
        for page in &mut doc.pages {
            page.image.clear();
        }
    }
    clip_text(&mut doc);
    Ok(doc)
}

#[tauri::command]
pub async fn tool_read_document(cwd: String, path: String, pages: Option<String>, pictures: Option<bool>) -> Result<DocRead, String> {
    let full = resolve(&cwd, &path);
    tauri::async_runtime::spawn_blocking(move || read_document(&full, pages.as_deref(), pictures.unwrap_or(true)))
        .await
        .map_err(|e| e.to_string())?
}

fn resolve(cwd: &str, path: &str) -> PathBuf {
    let p = expand_tilde(path.trim());
    if p.is_absolute() {
        p
    } else {
        expand_tilde(cwd).join(p)
    }
}

// ── Making documents ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MadeDocument {
    pub path: String,
    pub bytes: u64,
    /// A PDF showing how the document looks (the document itself when it's a PDF); the caller
    /// reads its pages back so the AI checks its work. Deleted by `tool_discard_preview`.
    pub preview_pdf: String,
    /// Share of the text printed under 7pt (too small to read on paper).
    pub small_text: f64,
    /// Text that spills out of its table cell or box.
    pub overflow: Vec<String>,
}

/// Content-Security-Policy put at the top of every document E.V renders: local files and inline
/// styles, scripts and pictures work; nothing can be fetched from or sent to the network.
pub const OFFLINE_POLICY: &str = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src file: data: blob:; style-src 'unsafe-inline' file: data:; font-src file: data:; script-src 'unsafe-inline' file:; media-src file: data:\">";

/// The HTML with OFFLINE_POLICY as the first thing in its head.
pub fn offline_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head) = lower.find("<head") {
        if let Some(end) = lower[head..].find('>') {
            let at = head + end + 1;
            return format!("{}{OFFLINE_POLICY}{}", &html[..at], &html[at..]);
        }
    }
    // No <head>: the parser puts a meta that comes before any content into the head it creates.
    let at = if lower.trim_start().starts_with("<!doctype") { lower.find('>').map(|i| i + 1).unwrap_or(0) } else { 0 };
    format!("{}{OFFLINE_POLICY}{}", &html[..at], &html[at..])
}

/// Writes `html` as a document at `path`: pdf (printed by the E.V Browser), docx / rtf / odt
/// (converted by textutil), or html. Relative image paths in the HTML resolve next to `path`.
pub fn make_document(path: &Path, format: &str, html: &str, landscape: bool, paper: &str) -> Result<MadeDocument, String> {
    let format = format.to_ascii_lowercase();
    if !["pdf", "docx", "rtf", "odt", "html"].contains(&format.as_str()) {
        return Err(format!("can't make a .{format} — use pdf, docx, rtf, odt or html"));
    }
    let dir = path.parent().ok_or("bad path")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    // The source sits next to the output so relative image paths work, and is removed afterwards.
    let source = dir.join(format!(".gideon-render-{stamp}.html"));
    std::fs::write(&source, offline_html(html)).map_err(|e| format!("couldn't write {}: {e}", source.display()))?;
    let result = (|| {
        let preview = std::env::temp_dir().join(format!("gideon-preview-{stamp}.pdf"));
        let printed = match format.as_str() {
            "pdf" => {
                let printed = crate::gideon_browser::print_pdf(&source, path, landscape, paper)?;
                std::fs::copy(path, &preview).map_err(|e| e.to_string())?;
                printed
            }
            "html" => {
                std::fs::write(path, html).map_err(|e| format!("couldn't save {}: {e}", path.display()))?;
                crate::gideon_browser::print_pdf(&source, &preview, landscape, paper)?
            }
            _ => {
                let out = Command::new("/usr/bin/textutil")
                    .args(["-format", "html", "-convert", &format, "-output"])
                    .arg(path)
                    .arg(&source)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!("couldn't convert to .{format}: {}", String::from_utf8_lossy(&out.stderr).trim()));
                }
                crate::gideon_browser::print_pdf(&source, &preview, landscape, paper)?
            }
        };
        let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        Ok(MadeDocument { path: path.display().to_string(), bytes, preview_pdf: preview.display().to_string(), small_text: printed.small_text, overflow: printed.overflow })
    })();
    let _ = std::fs::remove_file(&source);
    result
}

#[tauri::command]
pub async fn tool_make_document(cwd: String, path: String, format: String, html: String, landscape: Option<bool>, paper: Option<String>) -> Result<MadeDocument, String> {
    let full = resolve(&cwd, &path);
    tauri::async_runtime::spawn_blocking(move || make_document(&full, &format, &html, landscape.unwrap_or(false), paper.as_deref().unwrap_or("letter")))
        .await
        .map_err(|e| e.to_string())?
}

/// Removes a preview PDF made by `tool_make_document` (only ever files E.V named).
#[tauri::command]
pub fn tool_discard_preview(path: String) {
    let p = PathBuf::from(&path);
    let ours = p.parent() == Some(std::env::temp_dir().as_path()) && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("gideon-preview-") && n.ends_with(".pdf"));
    if ours {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_page_ranges() {
        assert_eq!(parse_pages("3", 10).unwrap(), vec![2]);
        assert_eq!(parse_pages("2-4", 10).unwrap(), vec![1, 2, 3]);
        assert_eq!(parse_pages("1,4,7-9", 10).unwrap(), vec![0, 3, 6, 7, 8]);
        assert_eq!(parse_pages("8-20", 10).unwrap(), vec![7, 8, 9]);
        assert_eq!(parse_pages("9-", 10).unwrap(), vec![8, 9]);
        assert!(parse_pages("0", 10).is_err());
        assert!(parse_pages("11", 10).is_err());
        assert!(parse_pages("x", 10).is_err());
        assert!(parse_pages("1-60", 100).is_err());
    }

    #[test]
    fn reads_office_xml() {
        let xml = r#"<p:sld><a:p><a:r><a:t>Title &amp; more</a:t></a:r></a:p><a:p><a:r><a:t>Line</a:t></a:r><a:br/><a:r><a:t>two</a:t></a:r></a:p></p:sld>"#;
        assert_eq!(office_xml_text(xml), "Title & more\nLine\ntwo");
        let sheet = r#"<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>hi</t></is></c></row></sheetData>"#;
        assert_eq!(sheet_rows(sheet, &["Name".into()]), "Name\t42\nhi");
    }

    /// Real E.V Browser: HTML → PDF and → Word, read back. `cargo test --lib makes_ -- --ignored`
    #[test]
    #[ignore]
    fn makes_pdf_and_word_documents() {
        let scratch = Scratch::new().unwrap();
        // Never the running app's browser profile.
        std::env::set_var("GIDEON_BROWSER_PROFILE", scratch.0.join("browser-profile"));
        // A local picture (must show) and a web one (must be blocked by OFFLINE_POLICY).
        std::fs::copy(fixture("words.png"), scratch.0.join("graph.png")).unwrap();
        let html = "<!doctype html><html><head><style>@page{size:letter;margin:0.5in} body{font:11pt Helvetica} .cols{column-count:2}</style></head><body><h1>Unit 5 Cheat Sheet</h1><div class=cols><p>Inverse: swap x and y, then solve for y.</p><p>Composition: evaluate the inside function first.</p></div><img src='graph.png' style='width:5in'><img src='http://127.0.0.1:18777/track.png'></body></html>";
        let pdf = scratch.0.join("sheet.pdf");
        let made = make_document(&pdf, "pdf", html, false, "letter").unwrap();
        assert!(made.bytes > 1000);
        assert_eq!(made.small_text, 0.0);
        assert!(made.overflow.is_empty(), "overflow: {:?}", made.overflow);
        let wide = make_document(&scratch.0.join("wide.pdf"), "pdf", "<table style='width:3in;table-layout:fixed'><tr><td style='white-space:nowrap'>Domain(f⁻¹) = Range(f), Range(f⁻¹) = Domain(f) and a lot more text</td><td>next</td></tr></table>", false, "letter").unwrap();
        assert!(!wide.overflow.is_empty(), "the overflowing cell wasn't caught");
        let _ = std::fs::remove_file(&wide.preview_pdf);
        // A formula wider than its cell spills into the next column without widening the cell.
        let math = make_document(&scratch.0.join("math.pdf"), "pdf", "<table style='width:2in;table-layout:fixed'><tr><td><math><mi>y</mi><mo>=</mo><mi>a</mi><msqrt><mi>x</mi><mo>−</mo><mi>h</mi><mo>−</mo><mi>h</mi><mo>−</mo><mi>h</mi></msqrt><mo>+</mo><mi>kkkkkkkkkk</mi></math></td><td>Vertex</td><td>c</td><td>d</td></tr></table>", false, "letter").unwrap();
        assert!(!math.overflow.is_empty(), "the overflowing formula wasn't caught");
        let _ = std::fs::remove_file(&math.preview_pdf);
        let tiny = make_document(&scratch.0.join("tiny.pdf"), "pdf", "<p style='font-size:6px'>far too small to read on paper</p><p>normal</p>", false, "letter").unwrap();
        assert!(tiny.small_text > 0.7, "small: {}", tiny.small_text);
        let _ = std::fs::remove_file(&tiny.preview_pdf);
        let doc = read_document(&pdf, None, true).unwrap();
        assert_eq!(doc.page_count, 1);
        assert!(doc.pages[0].text.contains("Unit 5 Cheat Sheet") && doc.pages[0].text.contains("evaluate the inside function first"), "{:?}", doc.pages[0].text);
        // Read the picture directly: the reader leaves out OCR that mostly repeats the text layer.
        let seen = pdf_page(&pdf, 0, None, true).unwrap().ocr;
        assert!(seen.contains("Quadratic formula"), "local picture missing: {seen:?}");
        let _ = std::fs::remove_file(&made.preview_pdf);
        let docx = scratch.0.join("sheet.docx");
        let made = make_document(&docx, "docx", html, false, "letter").unwrap();
        assert!(read_document(&docx, None, false).unwrap().text.contains("Inverse: swap x and y"));
        assert!(PathBuf::from(&made.preview_pdf).exists());
        tool_discard_preview(made.preview_pdf.clone());
        assert!(!PathBuf::from(&made.preview_pdf).exists());
        // The render source next to the output is cleaned up.
        assert!(std::fs::read_dir(&scratch.0).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".gideon-render")));
        crate::gideon_browser::stop();
    }

    /// `GIDEON_DOC=<file> cargo test --lib real_document -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_document() {
        let path = PathBuf::from(std::env::var("GIDEON_DOC").expect("set GIDEON_DOC"));
        let started = std::time::Instant::now();
        let doc = read_document(&path, std::env::var("GIDEON_PAGES").ok().as_deref(), true).unwrap();
        println!("{} {} pages, read {} in {:?}. {}", doc.kind, doc.page_count, doc.pages.len(), started.elapsed(), doc.note);
        for p in &doc.pages {
            println!("--- page {}: text {} chars, ocr {} chars, picture {}\n{}", p.number, p.text.len(), p.ocr.len(), !p.image.is_empty(), p.ocr.chars().take(300).collect::<String>());
        }
    }

    #[test]
    fn puts_the_offline_policy_first() {
        assert!(offline_html("<!doctype html><html><head><title>x</title></head><body>a</body></html>").starts_with(&format!("<!doctype html><html><head>{OFFLINE_POLICY}<title>")));
        assert!(offline_html("<HTML><HEAD lang=en><style></style></HEAD></HTML>").contains(&format!("<HEAD lang=en>{OFFLINE_POLICY}<style>")));
        assert_eq!(offline_html("<p>hi</p>"), format!("{OFFLINE_POLICY}<p>hi</p>"));
        assert_eq!(offline_html("<!DOCTYPE html><p>hi</p>"), format!("<!DOCTYPE html>{OFFLINE_POLICY}<p>hi</p>"));
    }

    #[test]
    fn keeps_only_new_ocr_words() {
        assert!(!adds_words("Power Functions and Transformations", "Power Functions Transformations"));
        assert!(adds_words("Power Functions", "Power Functions Introduction each parent function belongs special set called power functions"));
        assert!(adds_words("", "Quadratic formula with discriminant values shown here"));
        assert!(!adds_words("", "x 2 y"));
    }

    #[test]
    fn knows_document_kinds() {
        assert_eq!(document_kind("a/notes.PDF"), Some("pdf"));
        assert_eq!(document_kind("photo.heic"), Some("image"));
        assert_eq!(document_kind("deck.pptx"), Some("office"));
        assert_eq!(document_kind("letter.rtf"), Some("word"));
        assert_eq!(document_kind("main.rs"), None);
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
    }

    /// Real PDFKit + Vision through the Swift library: page 1 has a text layer, page 2 is only a
    /// picture of words, so it must be read with OCR.
    #[test]
    fn reads_pdfs_with_text_and_pictures() {
        let doc = read_document(&fixture("two-pages.pdf"), None, true).unwrap();
        assert_eq!(doc.kind, "pdf");
        assert_eq!(doc.page_count, 2);
        assert!(doc.pages[0].text.contains("Gideon reads documents"), "text layer: {:?}", doc.pages[0].text);
        assert!(!doc.pages[0].image.is_empty() && !doc.pages[1].image.is_empty());
        assert!(doc.pages[1].text.is_empty());
        assert!(doc.pages[1].ocr.contains("Quadratic formula"), "ocr: {:?}", doc.pages[1].ocr);
        let page_two = read_document(&fixture("two-pages.pdf"), Some("2"), false).unwrap();
        assert_eq!(page_two.pages.len(), 1);
        assert_eq!(page_two.pages[0].number, 2);
        assert!(page_two.pages[0].image.is_empty());
        // Page 1 has one line of text at the top: most of it is empty.
        assert!(doc.pages[0].blank > 0.8, "blank: {}", doc.pages[0].blank);
    }

    #[test]
    fn reads_images_with_ocr() {
        let doc = read_document(&fixture("words.png"), None, true).unwrap();
        assert_eq!(doc.kind, "image");
        assert!(!doc.pages[0].image.is_empty());
        assert!(doc.pages[0].ocr.contains("Quadratic formula"), "ocr: {:?}", doc.pages[0].ocr);
    }

    #[test]
    fn reads_word_documents_made_from_html() {
        let scratch = Scratch::new().unwrap();
        let html = scratch.0.join("in.html");
        std::fs::write(&html, "<h1>Unit 5</h1><p>Inverse functions swap x and y.</p>").unwrap();
        let docx = scratch.0.join("out.docx");
        assert!(Command::new("/usr/bin/textutil").args(["-convert", "docx", "-output"]).arg(&docx).arg(&html).status().unwrap().success());
        let doc = read_document(&docx, None, true).unwrap();
        assert_eq!(doc.kind, "word");
        assert!(doc.text.contains("Inverse functions swap x and y."), "{:?}", doc.text);
    }
}
