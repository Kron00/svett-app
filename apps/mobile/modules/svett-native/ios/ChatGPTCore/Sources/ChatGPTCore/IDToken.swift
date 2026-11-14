import Foundation
import Security

/// One key from OpenAI's published key set.
struct SigningKey: Codable, Equatable, Sendable {
    let kty: String
    let kid: String?
    let alg: String?
    let use: String?
    let n: String?
    let e: String?

    /// The RSA public key, or nil when this is not one.
    var publicKey: SecKey? {
        guard kty == "RSA", let n = n.flatMap(Data.init(base64URLEncoded:)),
              let e = e.flatMap(Data.init(base64URLEncoded:)) else { return nil }
        let der = RSAPublicKeyDER.encode(modulus: [UInt8](n), exponent: [UInt8](e))
        let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic]
        return SecKeyCreateWithData(Data(der) as CFData, attributes as CFDictionary, nil)
    }
}

/// OpenAI's published keys, from https://auth.openai.com/.well-known/jwks.json.
struct KeySet: Codable, Equatable, Sendable {
    let keys: [SigningKey]

    init(keys: [SigningKey]) {
        self.keys = keys
    }

    init?(body: Data) {
        guard let set = try? JSONDecoder().decode(KeySet.self, from: body) else { return nil }
        self = set
    }
}

/// Who signed in, from an ID token that passed every check.
struct VerifiedIdentity: Equatable, Sendable {
    let subject: String
    let email: String?
}

enum IDTokenProblem: String, Error, Equatable, Sendable {
    case malformed
    case unsupportedAlgorithm
    case unknownKey
    case badSignature
    case wrongIssuer
    case wrongAudience
    case expired
    case missingClaim
    case wrongNonce
}

/// The checks OpenAI's docs require of an ID token before the app trusts who signed in: the
/// signature against OpenAI's published keys, the issuer, the audience against the issued client
/// ID, the expiry, and the nonce saved for this attempt.
enum IDToken {
    /// OpenAI's own example allows five seconds between the phone's clock and its own.
    static let clockTolerance: TimeInterval = 5

    static func verify(
        _ token: String, keys: KeySet, clientID: String, nonce: String, now: Date
    ) -> Result<VerifiedIdentity, IDTokenProblem> {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3,
              let header = Data(base64URLEncoded: parts[0]).flatMap({ try? JSONDecoder().decode(Header.self, from: $0) }),
              let claims = Data(base64URLEncoded: parts[1]).flatMap({ try? JSONDecoder().decode(Claims.self, from: $0) }),
              let signature = Data(base64URLEncoded: parts[2])
        else { return .failure(.malformed) }
        guard header.alg == "RS256" else { return .failure(.unsupportedAlgorithm) }
        let candidates = keys.keys.filter {
            ($0.alg ?? "RS256") == "RS256" && ($0.use ?? "sig") == "sig" && (header.kid == nil || $0.kid == header.kid)
        }.compactMap(\.publicKey)
        guard !candidates.isEmpty else { return .failure(.unknownKey) }
        let signed = Data("\(parts[0]).\(parts[1])".utf8) as CFData
        let verified = candidates.contains {
            SecKeyVerifySignature($0, .rsaSignatureMessagePKCS1v15SHA256, signed, signature as CFData, nil)
        }
        guard verified else { return .failure(.badSignature) }
        guard claims.iss == OpenAI.issuer else { return .failure(.wrongIssuer) }
        guard claims.aud?.values.contains(clientID) == true, (claims.azp ?? clientID) == clientID else {
            return .failure(.wrongAudience)
        }
        guard let expiry = claims.exp, claims.iat != nil else { return .failure(.missingClaim) }
        guard now.timeIntervalSince1970 < expiry + clockTolerance else { return .failure(.expired) }
        guard claims.nonce == nonce else { return .failure(.wrongNonce) }
        guard let subject = claims.sub, !subject.isEmpty else { return .failure(.missingClaim) }
        return .success(VerifiedIdentity(subject: subject, email: claims.email))
    }

    private struct Header: Decodable {
        let alg: String
        let kid: String?
    }

    private struct Claims: Decodable {
        let iss: String?
        let sub: String?
        let aud: Audience?
        let azp: String?
        let exp: TimeInterval?
        let iat: TimeInterval?
        let nonce: String?
        let email: String?
    }

    /// `aud` is one client ID or a list of them.
    private struct Audience: Decodable {
        let values: [String]

        init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let one = try? container.decode(String.self) {
                values = [one]
            } else {
                values = try container.decode([String].self)
            }
        }
    }
}

/// An RSA public key in the PKCS #1 form that `SecKeyCreateWithData` reads: a DER sequence of
/// the modulus and the exponent.
enum RSAPublicKeyDER {
    static func encode(modulus: [UInt8], exponent: [UInt8]) -> [UInt8] {
        let body = integer(modulus) + integer(exponent)
        return [0x30] + length(body.count) + body
    }

    static func decode(_ der: [UInt8]) -> (modulus: [UInt8], exponent: [UInt8])? {
        var outer = Reader(bytes: der)
        guard let body = outer.read(tag: 0x30) else { return nil }
        var inner = Reader(bytes: body)
        guard let modulus = inner.read(tag: 0x02), let exponent = inner.read(tag: 0x02) else { return nil }
        return (Array(modulus.drop { $0 == 0 }), Array(exponent.drop { $0 == 0 }))
    }

    /// A DER integer is signed, so a leading byte with its top bit set gets a zero in front.
    private static func integer(_ bytes: [UInt8]) -> [UInt8] {
        var value = Array(bytes.drop { $0 == 0 })
        if value.isEmpty || value[0] & 0x80 != 0 { value.insert(0, at: 0) }
        return [0x02] + length(value.count) + value
    }

    private static func length(_ count: Int) -> [UInt8] {
        guard count >= 0x80 else { return [UInt8(count)] }
        var bytes: [UInt8] = []
        var rest = count
        while rest > 0 {
            bytes.insert(UInt8(rest & 0xFF), at: 0)
            rest >>= 8
        }
        return [0x80 | UInt8(bytes.count)] + bytes
    }

    private struct Reader {
        let bytes: [UInt8]
        var position = 0

        mutating func read(tag: UInt8) -> [UInt8]? {
            guard position + 2 <= bytes.count, bytes[position] == tag else { return nil }
            var length = Int(bytes[position + 1])
            position += 2
            if length & 0x80 != 0 {
                let count = length & 0x7F
                guard count <= 4, position + count <= bytes.count else { return nil }
                length = bytes[position..<position + count].reduce(0) { $0 << 8 | Int($1) }
                position += count
            }
            guard position + length <= bytes.count else { return nil }
            defer { position += length }
            return Array(bytes[position..<position + length])
        }
    }
}
