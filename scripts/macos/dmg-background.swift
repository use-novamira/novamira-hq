// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import AppKit

// Coordinates below describe a 720 × 480 Finder canvas.
let image = NSImage(size: NSSize(width: 720, height: 480))
image.lockFocus()
NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: 720, height: 480).fill()
func text(_ value: String, y: CGFloat, size: CGFloat, bold: Bool = false) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
        .font: bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size),
        .foregroundColor: NSColor(calibratedWhite: 0.10, alpha: 1),
        .paragraphStyle: style,
    ]
    (value as NSString).draw(in: NSRect(x: 30, y: y, width: 660, height: 45), withAttributes: attributes)
}
text("Novamira HQ", y: 385, size: 34, bold: true)
text("Drag Novamira HQ to Applications", y: 335, size: 22)
text("Then open Novamira HQ from Applications.", y: 40, size: 16)
NSColor(calibratedRed: 0.97, green: 0.76, blue: 0.22, alpha: 1).setStroke()
let arrow = NSBezierPath()
arrow.lineWidth = 7
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 305, y: 190))
arrow.line(to: NSPoint(x: 415, y: 190))
arrow.move(to: NSPoint(x: 396, y: 209))
arrow.line(to: NSPoint(x: 415, y: 190))
arrow.line(to: NSPoint(x: 396, y: 171))
arrow.stroke()
image.unlockFocus()
guard CommandLine.arguments.count == 2,
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not render DMG background")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
