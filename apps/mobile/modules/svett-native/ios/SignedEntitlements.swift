import Foundation
import MachO

/// The entitlements the running app was signed with. On a phone they are in the code signature that
/// AltStore wrote, so this shows what AltStore kept. Xcode signs a simulator build with empty
/// entitlements and puts the real ones in a section of the executable, which the simulator grants.
enum SignedEntitlements {
    static func keys() -> [String]? {
        #if targetEnvironment(simulator)
        let xml = fromSimulatorSection()
        #else
        let xml = fromSignature()
        #endif
        guard let xml,
              let entitlements = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any]
        else { return nil }
        return entitlements.keys.sorted()
    }

    private static let machHeader64Magic: UInt32 = 0xfeed_facf
    private static let codeSignatureCommand: UInt32 = 0x1d
    private static let superBlobMagic: UInt32 = 0xfade_0cc0
    private static let entitlementsSlot: UInt32 = 5
    private static let entitlementsMagic: UInt32 = 0xfade_7171

    /// Reads the XML entitlements blob from the executable's code signature. The Mach-O header is
    /// little-endian and the signature is big-endian.
    private static func fromSignature() -> Data? {
        guard let path = Bundle.main.executablePath, let file = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? file.close() }
        guard let header = try? file.read(upToCount: 32), header.uint32(at: 0) == machHeader64Magic,
              let commandCount = header.uint32(at: 16), let commandsSize = header.uint32(at: 20),
              let commands = try? file.read(upToCount: Int(commandsSize))
        else { return nil }

        var offset = 0
        var signature: (offset: UInt32, size: UInt32)?
        for _ in 0..<commandCount {
            guard let command = commands.uint32(at: offset), let size = commands.uint32(at: offset + 4), size > 0 else {
                return nil
            }
            if command == codeSignatureCommand, let dataOffset = commands.uint32(at: offset + 8),
               let dataSize = commands.uint32(at: offset + 12) {
                signature = (dataOffset, dataSize)
                break
            }
            offset += Int(size)
        }
        guard let signature, (try? file.seek(toOffset: UInt64(signature.offset))) != nil,
              let blob = try? file.read(upToCount: Int(signature.size)),
              blob.uint32(at: 0, bigEndian: true) == superBlobMagic,
              let count = blob.uint32(at: 8, bigEndian: true)
        else { return nil }

        for index in 0..<Int(count) {
            guard let slot = blob.uint32(at: 12 + index * 8, bigEndian: true),
                  let start = blob.uint32(at: 16 + index * 8, bigEndian: true).map({ Int($0) })
            else { return nil }
            guard slot == entitlementsSlot, blob.uint32(at: start, bigEndian: true) == entitlementsMagic,
                  let length = blob.uint32(at: start + 4, bigEndian: true).map({ Int($0) }),
                  length >= 8, start + length <= blob.count
            else { continue }
            return blob.subdata(in: blob.startIndex + start + 8 ..< blob.startIndex + start + length)
        }
        return nil
    }

    private static func fromSimulatorSection() -> Data? {
        for index in 0..<_dyld_image_count() {
            guard let header = _dyld_get_image_header(index), header.pointee.filetype == UInt32(MH_EXECUTE) else {
                continue
            }
            var size: UInt = 0
            let start = header.withMemoryRebound(to: mach_header_64.self, capacity: 1) {
                getsectiondata($0, "__TEXT", "__entitlements", &size)
            }
            guard let start, size > 0 else { return nil }
            return Data(bytes: start, count: Int(size))
        }
        return nil
    }
}

private extension Data {
    func uint32(at offset: Int, bigEndian: Bool = false) -> UInt32? {
        guard offset >= 0, offset + 4 <= count else { return nil }
        let raw = self[startIndex + offset ..< startIndex + offset + 4].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        return bigEndian ? UInt32(bigEndian: raw) : UInt32(littleEndian: raw)
    }
}
