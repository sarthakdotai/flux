// Draws the Flux app icon (lime squircle, onyx stamp asterisk) as a 1024px PNG.
// The asterisk comes from design/asterisk.path (M/L/Z polygons in a -12..12 box), the same
// shape the web logo uses. Usage: swift make-icon.swift asterisk.path out.png
import AppKit

let size: CGFloat = 1024
let pathText = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// macOS icon grid: 824px body centred in 1024, corner radius ~185.
NSColor(red: 0xDF / 255, green: 0xFF / 255, blue: 0x3B / 255, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185).fill()

// SVG y points down, AppKit y points up: flip while scaling into the icon.
let scale: CGFloat = 21
let asterisk = NSBezierPath()
let tokens = pathText.replacingOccurrences(of: "M", with: " M ").replacingOccurrences(of: "L", with: " L ")
    .replacingOccurrences(of: "Z", with: " Z ").split(whereSeparator: \.isWhitespace).map(String.init)
var i = 0
while i < tokens.count {
    let command = tokens[i]
    if command == "Z" { asterisk.close(); i += 1; continue }
    let point = NSPoint(x: size / 2 + CGFloat(Double(tokens[i + 1])!) * scale, y: size / 2 - CGFloat(Double(tokens[i + 2])!) * scale)
    if command == "M" { asterisk.move(to: point) } else { asterisk.line(to: point) }
    i += 3
}
asterisk.windingRule = .nonZero
NSColor(red: 0x0B / 255, green: 0x0B / 255, blue: 0x0B / 255, alpha: 1).setFill()
asterisk.fill()
image.unlockFocus()

let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
