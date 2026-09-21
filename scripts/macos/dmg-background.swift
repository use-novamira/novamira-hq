// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import AppKit

// Coordinates below describe a 720 × 480 Finder canvas.
guard CommandLine.arguments.count == 2,
      let logo = NSImage(contentsOf: URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("novamira-hq-logo.svg")),
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1440,
        pixelsHigh: 960, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Could not load DMG logo or create canvas")
}
bitmap.size = NSSize(width: 720, height: 480)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.scaleBy(x: 2, y: 2)
NSColor(calibratedRed: 0.98, green: 0.98, blue: 0.96, alpha: 1).setFill()
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
logo.draw(in: NSRect(x: 220, y: 394, width: 280, height: 280 * 8.83 / 87.64))
text("Drag Novamira HQ to Applications", y: 313, size: 27, bold: true)
NSColor(calibratedRed: 0.97, green: 0.76, blue: 0.22, alpha: 1).setStroke()
let arrow = NSBezierPath()
arrow.lineWidth = 5
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 308, y: 199))
arrow.curve(to: NSPoint(x: 412, y: 199),
    controlPoint1: NSPoint(x: 335, y: 177), controlPoint2: NSPoint(x: 382, y: 177))
arrow.move(to: NSPoint(x: 392, y: 202))
arrow.line(to: NSPoint(x: 412, y: 199))
arrow.line(to: NSPoint(x: 408, y: 179))
arrow.stroke()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not render DMG background")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
