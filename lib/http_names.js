// 내려받기 Content-Disposition — 바이트 안전한 이름(name) 뒤에 한글 원래 이름은 RFC 5987 filename* 로 붙인다.
export function downloadDisposition(name, downloadName) {
  return `attachment; filename="${name}"${downloadName ? `; filename*=UTF-8''${encodeURIComponent(downloadName)}` : ''}`;
}
