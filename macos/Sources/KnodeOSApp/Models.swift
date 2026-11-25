import Foundation
import SwiftUI

/**
 * Navigation is two levels: a section in the sidebar, a tab inside it.
 *
 * The grouping follows what the workspace does with material rather than
 * what the service implements (docs/design/20): material comes in (Library),
 * you look things up in it (Explore — Search, Ask and Research, one intent at
 * three depths), knowledge grows out of it (Knowledge), and work runs on it
 * (Tasks). A section whose `tabs` holds a single entry shows no tab strip.
 */
enum AppSection: String, CaseIterable, Identifiable, Codable {
    case library
    case explore
    case knowledge
    case tasks
    case settings

    var id: String { rawValue }

    var tabs: [AppTab] {
        switch self {
        case .library: [.files]
        case .explore: [.search, .ask, .studies]
        case .knowledge: [.graph, .entities, .wiki]
        case .tasks: [.queue, .dream]
        case .settings: [.providers, .pipeline, .research, .chat, .playbooks, .workspace, .access]
        }
    }

    @MainActor var title: String {
        switch self {
        case .library: L("Library")
        // "Explore" alone is the graph's button, 展开
        case .explore: L("Explore", context: "section")
        case .knowledge: L("Knowledge")
        case .tasks: L("Tasks")
        case .settings: L("Settings")
        }
    }

    @MainActor var subtitle: String {
        switch self {
        case .library: L("Files and imported data")
        case .explore: L("Search, ask, or research your knowledge")
        case .knowledge: L("Graph, entities, and wiki")
        case .tasks: L("Processing queue, workers, and Dream")
        case .settings: L("Models, ingest, research, and Ask")
        }
    }

    var symbol: String {
        switch self {
        case .library: "books.vertical"
        case .explore: "sparkle.magnifyingglass"
        case .knowledge: "lightbulb"
        case .tasks: "list.bullet.clipboard"
        case .settings: "slider.horizontal.3"
        }
    }
}

/// A screen. Every tab belongs to exactly one section, which is what the
/// sidebar selects; `AppSection.tabs` is the inverse and the two must agree.
///
/// Settings reads as the three things a workspace does with knowledge, in the
/// order it happens: documents are processed as they come in (Ingest), agents
/// research them into the wiki (Research), and the result answers questions
/// (Ask). Ids keep their first names, so `pipeline` is titled Ingest; Ask's
/// settings are `chat` — the config block they edit — because `ask` is the
/// Ask screen itself; and Explore's Research is `studies`, because `research`
/// is its settings page.
enum AppTab: String, CaseIterable, Identifiable, Codable {
    case files
    case search
    case ask
    case studies
    case graph
    case entities
    case wiki
    case queue
    case dream
    case providers
    case pipeline
    case research
    case chat
    case playbooks
    case workspace
    case access

    var id: String { rawValue }

    /**
     * A tab that used to exist, so a stored navigation still lands somewhere.
     * `agents` was folded into `providers` in 2026-09-19: an agent runs on a
     * provider from the table above it, and the two were never separable in
     * anything but the tab strip. `traces` went into Dream in 2026-10-30
     * (docs/design/20 D8): the traces are what Dream reads.
     */
    static func named(_ raw: String) -> AppTab? {
        if let tab = AppTab(rawValue: raw) { return tab }
        switch raw {
        case "agents": return .providers
        case "traces": return .dream
        default: return nil
        }
    }

    var section: AppSection {
        switch self {
        case .files: .library
        case .search, .ask, .studies: .explore
        case .graph, .entities, .wiki: .knowledge
        case .queue, .dream: .tasks
        case .providers, .pipeline, .research, .chat, .playbooks, .workspace, .access: .settings
        }
    }

    /**
     * Which screen shows this tab. Settings' five config tabs share one host:
     * keying view identity on the leaf instead would rebuild `SettingsView` on
     * every sub-tab click, refetching the config and discarding unsaved routes.
     * Access is a screen of its own.
     */
    var host: String {
        section == .settings && self != .access ? "settings" : rawValue
    }

    @MainActor var title: String {
        switch self {
        case .files: L("Files")
        case .search: L("Search")
        case .ask: L("Ask")
        case .studies: L("Research")
        case .graph: L("Graph")
        case .entities: L("Entities")
        case .wiki: L("Wiki")
        // "Queue" alone is the verb on Wiki's recommendations
        case .queue: L("Queue", context: "tab")
        case .dream: L("Dream")
        case .providers: L("Providers & Agents")
        case .pipeline: L("Ingest")
        case .research: L("Research")
        case .chat: L("Ask")
        case .playbooks: L("Playbooks")
        case .workspace: L("Workspace")
        case .access: L("Access")
        }
    }

    @MainActor var subtitle: String {
        switch self {
        case .files: L("Browse and edit knowledge")
        case .search: L("What a query matches, and why")
        case .ask: L("An agent that answers from your workspace")
        case .studies: L("Research a topic into several wiki pages")
        case .graph: L("Entities, relations, and claims")
        case .entities: L("Every entity, filtered and sorted")
        case .wiki: L("Pages researched by agent CLIs")
        case .queue: L("What runs, waits, and is scheduled")
        case .dream: L("Review agent improvement ideas")
        case .providers: L("Endpoints, credentials, and who does the work")
        case .pipeline: L("How documents get processed")
        case .research: L("How the wiki gets written")
        case .chat: L("How questions get answered")
        case .playbooks: L("Templates, prompts, and vocabularies agents follow")
        case .workspace: L("Clear this workspace")
        case .access: L("Your account; users and gateways of this server")
        }
    }

    var symbol: String {
        switch self {
        case .files: "doc.text"
        case .search: "magnifyingglass"
        case .ask: "sparkles"
        case .studies: "doc.text.magnifyingglass"
        case .graph: "point.3.connected.trianglepath.dotted"
        case .entities: "tablecells"
        case .wiki: "book.closed"
        case .queue: "list.bullet.rectangle"
        case .dream: "moon.stars"
        case .providers: "cable.connector"
        case .pipeline: "tray.and.arrow.down"
        case .research: "book.and.wrench"
        case .chat: "bubble.left.and.bubble.right"
        case .playbooks: "doc.badge.gearshape"
        case .workspace: "exclamationmark.triangle"
        case .access: "person.badge.key"
        }
    }
}

enum WorkspaceKind: String, Codable, CaseIterable {
    case personal
    case team
}

struct Workspace: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var kind: WorkspaceKind
    var code: String?
    var createdAt: String?

    var displayName: String { name }
    var detail: String { kind == .personal ? "Private workspace" : "Team workspace" }
}

struct UserProfile: Codable, Hashable {
    var username: String
    var name: String
    /// "admin" or "member", as the service last said; absent in sessions stored before sign-in was real.
    var role: String?

    var isAdmin: Bool { role == "admin" }
}

struct StoredSession: Codable {
    var user: UserProfile
    var workspaces: [Workspace]
    var activeWorkspaceID: String
}

struct ServerHealth: Decodable {
    var ok: Bool
    var dataRoot: String?
    var workspaceIsolation: Bool?
    var auth: HealthAuth?

    struct HealthAuth: Decodable {
        var enabled: Bool
        var setupRequired: Bool?
    }
}

/* ------------------------------- sign-in -------------------------------- */

/// An account as the service shows it (src/auth/accounts.ts), never with its password.
struct AuthAccount: Codable, Hashable, Identifiable {
    var username: String
    var name: String
    var role: String
    var teams: [String]
    var remoteApis: [String]
    var gateways: [String]
    /// A member who may look and not change anything.
    var readOnly: Bool?
    var disabled: Bool?
    var createdAt: String?
    var passwordChangedAt: String?

    var id: String { username }
    var isAdmin: Bool { role == "admin" }
    @MainActor var roleTitle: String { isAdmin ? L("administrator") : readOnly == true ? L("member, read-only") : L("member") }
}

struct AuthTeam: Decodable, Hashable {
    var id: String
    var name: String
    var slug: String
}

struct AuthGateway: Decodable, Hashable, Identifiable {
    var id: String
    var description: String
    var path: String
}

/// Who you are signed in as and what you may use from where you are.
struct AuthSnapshot: Decodable {
    var account: AuthAccount
    var local: Bool?
    var groups: [String: Bool]?
    var teams: [AuthTeam]?
    var gateways: [AuthGateway]?
    var apiGroups: [String: String]?
    /// Only in a sign-in's answer, once.
    var token: String?
}

/// GET /api/auth/state: what the sign-in screen needs before anyone is signed in.
struct AuthState: Decodable {
    var auth: Bool
    var setupRequired: Bool?
    var canSetup: Bool?
    var local: Bool?
    var minPasswordLength: Int?
}

/// A password change or "sign out others" ends every session but the one asking, which gets a new token.
struct AuthRenewal: Decodable {
    var ok: Bool
    var token: String?
}

struct AuthSessionRow: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var label: String
    var createdAt: String
    var lastSeenAt: String
    var expiresAt: String
    var ip: String?
    var current: Bool?
}

struct AdminUser: Decodable, Identifiable, Hashable {
    var username: String
    var name: String
    var role: String
    var teams: [String]
    var remoteApis: [String]
    var gateways: [String]
    var readOnly: Bool?
    var disabled: Bool?
    var sessions: Sessions

    struct Sessions: Decodable, Hashable {
        var count: Int
        var lastSeenAt: String?
    }

    var id: String { username }
}

struct AdminUsersResponse: Decodable {
    var users: [AdminUser]
    var apiGroups: [String: String]
    var teams: [String]
    var gateways: [String]
}

/// What the admin form sends; nil fields are left as they are.
struct AdminUserDraft: Encodable {
    var username: String?
    var name: String?
    var password: String?
    var role: String?
    var teams: [String]?
    var remoteApis: [String]?
    var gateways: [String]?
    var readOnly: Bool?
    var disabled: Bool?
}

/* ------------------------------ processing ------------------------------ */

/// Whether the workspace's processing runs: extraction slots, reviews and
/// summary pages. The service starts it in every workspace; a stop lasts
/// until someone starts it again or the service restarts.
struct ProcessingState: Decodable, Equatable {
    var running: Bool
    var since: String?
    var by: String?
}

/// GET /api/labeling/status, the parts the app shows.
struct LabelingStatusResponse: Decodable, Equatable {
    var processing: ProcessingState?
    var scheduler: Scheduler?
    var local: [LocalBackend]
    /// The Translate stage's leased work (docs/design/17); nil from an older service.
    var translations: Translations?
    /// Summary pages and judge calls out now; only how many is read.
    var summaries: Leased?
    var judge: Leased?

    /// A lease the toolbar only counts: whatever it holds, it decodes.
    struct CountedLease: Decodable, Equatable {
        init(from decoder: any Decoder) throws {}
    }

    struct Leased: Decodable, Equatable {
        var leases: [CountedLease]?
    }

    /// Model calls out right now, every kind together — what the toolbar's
    /// processing pill counts, as the web header does.
    var inFlight: Int {
        (scheduler?.leases?.count ?? 0) + (summaries?.leases?.count ?? 0)
            + (translations?.leases.count ?? 0) + (judge?.leases?.count ?? 0)
    }

    /// Counted in translations — a document into one language — which is
    /// what `due` and the last hour count; a long document's segments can be
    /// out to several workers at once, so the leases are folded to that.
    struct Translations: Decodable, Equatable {
        var enabled: Bool
        var primary: String?
        var due: Int
        var leases: [Lease]
        var lastHour: Hour?

        /// Optional, like everything this panel reads, so an odd lease can
        /// never cost the whole status.
        struct Lease: Decodable, Equatable {
            var document: String?
            var language: String?
        }

        struct Hour: Decodable, Equatable {
            var calls: Int?
            var documents: Int?
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
            primary = try container.decodeIfPresent(String.self, forKey: .primary)
            due = try container.decodeIfPresent(Int.self, forKey: .due) ?? 0
            leases = try container.decodeIfPresent([Lease].self, forKey: .leases) ?? []
            lastHour = try container.decodeIfPresent(Hour.self, forKey: .lastHour)
        }

        private enum CodingKeys: String, CodingKey {
            case enabled, primary, due, leases, lastHour
        }

        /// Translations a worker holds a segment of right now.
        var inProgress: Int { Set(leases.map { "\($0.document ?? "")\u{0}\($0.language ?? "")" }).count }

        /// One line for the processing panel and the Translate stage alike.
        @MainActor var queueLine: String {
            L("Translations: %@ due, %@ in progress, %@ written in the last hour", String(due), String(inProgress), String(lastHour?.documents ?? 0))
        }
    }

    struct Scheduler: Decodable, Equatable {
        var queued: Int
        var workers: [Worker]?
        var lastHour: LastHour?
        /// Extraction segments out now.
        var leases: [CountedLease]?
    }

    struct Worker: Decodable, Equatable {
        var worker: String
        var remote: Bool
        var leased: Int
    }

    struct LastHour: Decodable, Equatable {
        var calls: Int
        var documentsWritten: Int
    }

    struct LocalBackend: Decodable, Equatable, Identifiable {
        var id: String
        var label: String
        var slots: Int
        var busy: Int
        var pausedUntil: String?
        var pauseReason: String?
    }

    /// Remote workers that held work lately.
    var remoteWorkers: Int { scheduler?.workers?.filter { $0.remote && $0.leased > 0 }.count ?? 0 }
}

/// POST /api/labeling/start | stop.
struct ProcessingSwitchResponse: Decodable {
    var ok: Bool
    var changed: Bool
    var processing: ProcessingState
}

struct GatewayRecord: Decodable, Identifiable, Hashable {
    var id: String
    var target: String
    var description: String?
    var sandbox: Bool?
    var passAuthorization: Bool?
    var createdAt: String?
}

struct KnowledgeStats: Decodable, Equatable {
    var documents: Int
    var chunks: Int
    var embeddings: Int?
    var entities: Int
    var relations: Int
    var traces: Int
    var pendingSuggestions: Int
    var extractionQueue: Int?
    /// Extraction calls still to make for the queue (a long document counts its segments).
    var extractionSegments: Int?
    var embeddingModel: String?
    var llmModel: String?
    var lastDream: LastDream?

    struct LastDream: Decodable, Equatable {
        var at: String?
        var report: String?
        var sessions: Int?
    }
}

enum TreeNodeKind: String, Decodable {
    case file
    case dir
}

struct TreeNode: Decodable, Identifiable, Hashable {
    var name: String
    var path: String
    var kind: TreeNodeKind
    var bytes: Int?
    var mtime: String?
    var children: [TreeNode]?
    /// What a folder knode-os makes is for (FOLDER_ABOUT in the service), in
    /// English; the row shows it through `L`, which knows every one.
    var about: String?
    /// The folder on the service's machine a linked folder mirrors.
    var linked: String?

    var id: String { path.isEmpty ? "__root__" : path }
    var isWritable: Bool { path == "wiki" || path.hasPrefix("wiki/") || path == "raw/docs" || path.hasPrefix("raw/docs/") }

    /// The code repository this row is the mirror, card or documentation copy
    /// of (raw/codebase/<name>, raw/docs/codebase/<name>.md, raw/docs/codebase/<name>);
    /// nil for anything else. The service owns those paths (docs/design/25).
    var codebaseName: String? {
        guard linked != nil else { return nil }
        for prefix in ["raw/codebase/", "raw/docs/codebase/"] where path.hasPrefix(prefix) {
            var rest = String(path.dropFirst(prefix.count))
            if prefix == "raw/docs/codebase/", rest.hasSuffix(".md") { rest = String(rest.dropLast(3)) }
            if !rest.isEmpty, !rest.contains("/") { return rest }
        }
        return nil
    }

    /// Root files the file view may edit although nothing else may happen to
    /// them there — no move, rename or delete: what the workspace is for and
    /// the rules its wiki follows (OWNER_ROOT_FILES in the service).
    static let ownerRootFiles: Set<String> = ["purpose.md", "schema.md"]
}

struct FileResponse: Decodable {
    var path: String
    var content: String
    /// Size on disk, which is larger than `content` when the read was capped.
    var bytes: Int?
    var truncated: Bool?
    /// True when the text is Markdown knode-os derived from a PDF or image
    /// rather than the file's own bytes — readable, never editable.
    var derived: Bool?
    /// The document's languages, for an indexed raw/docs document in a
    /// workspace with content languages on. An older service sends none.
    var languages: FileLanguages?
    /// Only when `content` is a translation rather than the original.
    var translation: FileTranslation?
}

/// What `GET /api/file` says about a document's languages (docs/design/17 §4):
/// which one it is written in, which ones a reader may pick, and how far the
/// translation into each one got.
struct FileLanguages: Decodable, Equatable {
    /// The language the document is written in; nil for a text without letters.
    var source: String?
    var primary: String?
    /// The workspace's languages, the primary first, and the document's own
    /// when it is neither.
    var offered: [String]
    /// The language `content` is in: the asked one when it is translated,
    /// else the source.
    var shown: String?
    /// Whether the service translates the document into the primary language
    /// by itself — a raw/docs source, not a wiki page; nil from a service
    /// older than the field, which did so for every document it offered.
    var background: Bool?
    var translations: [String: TranslationState]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        primary = try container.decodeIfPresent(String.self, forKey: .primary)
        offered = try container.decodeIfPresent([String].self, forKey: .offered) ?? []
        shown = try container.decodeIfPresent(String.self, forKey: .shown)
        background = try container.decodeIfPresent(Bool.self, forKey: .background)
        translations = try container.decodeIfPresent([String: TranslationState].self, forKey: .translations) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case source, primary, offered, shown, background, translations
    }
}

/// One language of a document: "source" for its own, then "none",
/// "requested", "partial", "done", "failed" or "skipped".
struct TranslationState: Decodable, Equatable {
    var status: String
    var parts: Int
    var done: Int
    var model: String?
    var generatedAt: String?
    var requested: Bool?
    var error: String?

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "none"
        parts = try container.decodeIfPresent(Int.self, forKey: .parts) ?? 0
        done = try container.decodeIfPresent(Int.self, forKey: .done) ?? 0
        model = try container.decodeIfPresent(String.self, forKey: .model)
        generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        requested = try container.decodeIfPresent(Bool.self, forKey: .requested)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    init(status: String, parts: Int = 0, done: Int = 0, requested: Bool? = nil) {
        self.status = status
        self.parts = parts
        self.done = done
        self.requested = requested
    }

    private enum CodingKeys: String, CodingKey {
        case status, parts, done, model, generatedAt, requested, error
    }
}

/// The translation `content` is: a partial one has `done` of `parts`
/// segments translated and the original standing in for the rest. All of it
/// optional, so a surprise here never keeps the file itself from opening.
struct FileTranslation: Decodable, Equatable {
    var language: String?
    var done: Int?
    var parts: Int?
    var model: String?
}

/// `POST /api/file/translate`. `processing` false says this machine's
/// processing is stopped, so the request waits for it — or for a remote
/// worker; a withdrawn request answers without it.
struct TranslationRequestResponse: Decodable {
    var ok: Bool?
    var status: String?
    var processing: Bool?
}

/// A language knode-os can detect and translate into (`LANGUAGES` in
/// src/lang/languages.ts): `native` is what a switcher shows, `english`
/// what a settings list explains it with.
struct ContentLanguage: Decodable, Identifiable, Hashable {
    var code: String
    var english: String
    var native: String
    var prompt: String?

    var id: String { code }

    /// The service's catalog as of docs/design/17, for an older service that
    /// has no `GET /api/languages`, and for naming a language in the file
    /// view without asking for the list again.
    static let builtin: [ContentLanguage] = [
        ContentLanguage(code: "zh", english: "Chinese (Simplified)", native: "简体中文"),
        ContentLanguage(code: "zh-Hant", english: "Chinese (Traditional)", native: "繁體中文"),
        ContentLanguage(code: "en", english: "English", native: "English"),
        ContentLanguage(code: "ja", english: "Japanese", native: "日本語"),
        ContentLanguage(code: "ko", english: "Korean", native: "한국어"),
        ContentLanguage(code: "fr", english: "French", native: "Français"),
        ContentLanguage(code: "de", english: "German", native: "Deutsch"),
        ContentLanguage(code: "es", english: "Spanish", native: "Español"),
        ContentLanguage(code: "pt", english: "Portuguese", native: "Português"),
        ContentLanguage(code: "it", english: "Italian", native: "Italiano"),
        ContentLanguage(code: "ru", english: "Russian", native: "Русский"),
    ]

    init(code: String, english: String, native: String, prompt: String? = nil) {
        self.code = code
        self.english = english
        self.native = native
        self.prompt = prompt
    }

    /// A code by its own name — 简体中文, English — or the code itself for a
    /// language this catalog does not know.
    static func nativeName(_ code: String) -> String {
        builtin.first { $0.code.caseInsensitiveCompare(code) == .orderedSame }?.native ?? code
    }

    /// The same in English, which `L` turns into the interface's language —
    /// what a sentence names a language by: "Translated from Japanese".
    static func englishName(_ code: String) -> String {
        builtin.first { $0.code.caseInsensitiveCompare(code) == .orderedSame }?.english ?? code
    }

    /// Whether text in `a` needs no translation into `b`, the Chinese scripts
    /// counted as one, as the service's `sameLanguage` counts them: detection
    /// reads the script and cannot tell simplified from traditional.
    static func same(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }
        func base(_ code: String) -> String { code.split(separator: "-").first.map { $0.lowercased() } ?? code.lowercased() }
        return base(a) == base(b)
    }
}

/// `GET /api/languages`: the languages knode-os knows and the workspace's own
/// settings, for pickers.
struct LanguagesResponse: Decodable {
    var languages: [ContentLanguage]
    var enabled: Bool?
    var primary: String?
    var secondary: [String]?
    var offered: [String]?
    var maxChars: Int?
}

/// The wiki pages citing a raw/docs file (`GET /api/file/citations`): its
/// `[[raw/docs/…]]` and Markdown links, `sources:` entries and typed
/// `relations:` such as `tested_by` (src/graph/citations.ts).
struct FileCitationsResponse: Decodable {
    var path: String
    var citedBy: [CitingPage]
}

struct CitingPage: Decodable, Identifiable {
    var path: String
    var title: String?
    /// `trusted`, or `quarantined` for a page an agent wrote that nobody has promoted yet.
    var trust: String
    var links: [CitationLink]

    var id: String { path }

    /// How the page cites the file, as it reads: "derived from · tested by".
    var labels: String {
        var seen = Set<String>()
        return links.map { $0.label.replacingOccurrences(of: "_", with: " ") }
            .filter { seen.insert($0).inserted }
            .joined(separator: " · ")
    }
}

struct CitationLink: Decodable {
    var type: String
    var inverse: Bool
    /// The predicate as the page states it toward the file: an inverse row reads as its inverse name (`tests`).
    var label: String
    /// `wikilink`, `embed`, `markdown`, `sources` or `relations`.
    var via: String
    var fragment: String?
}

/// Where a followed link leads (GET /api/link/resolve): a file, or — for a name no
/// note answers to but the graph knows — the entity, whose panel the link opens.
struct ResolvedLinkResponse: Decodable {
    struct Entity: Decodable {
        var id: String
        var name: String
        var type: String
    }

    var path: String?
    var fragment: String?
    var entity: Entity?
}

struct SearchResult: Decodable, Identifiable, Hashable {
    var chunkId: String
    var documentId: String
    var path: String
    var title: String?
    var content: String
    var score: Double
    var signals: [String: Double]

    var id: String { chunkId }
}

struct Claim: Decodable, Hashable, Identifiable {
    var id: String
    var subject: String
    var object: String?
    var type: String
    var statement: String
    var status: String
    var startDate: String?
    var endDate: String?
    var path: String?
}

struct GraphNode: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var type: String
    var description: String
    /// Mentions in an overview; hop-decayed relevance to the query in a search.
    var score: Double
    var mentionCount: Int
    /// Live typed relations across the whole graph, not only the ones in view; absent from older services.
    var degree: Int?
    var wikiPath: String?
    /// Index into the reply's `communities`; absent for a node linked to nothing in the reply, and from older services.
    var community: Int? = nil
}

/// A group of nodes linked to each other more than to the rest of a graph read: what the view draws as an island.
struct GraphCommunity: Decodable, Hashable, Identifiable {
    /// Its position in the reply's list: largest first.
    var id: Int
    var size: Int
    /// The member with the most relations: its id, and its name as the community's label.
    var hub: String
    var label: String
}

struct GraphEdge: Decodable, Hashable, Identifiable {
    var source: String
    var target: String
    var type: String
    var description: String
    var weight: Double
    /// Date-only world-time window, when the relation carries one.
    var validFrom: String? = nil
    var validTo: String? = nil
    var id: String { "\(source)-\(target)-\(type)" }
}

struct GraphResponse: Decodable {
    var nodes: [GraphNode]
    var edges: [GraphEdge]
    var chunks: [SearchResult]
    var claims: [Claim]?
    /// The nodes' communities; absent from older services, which then draw as one layout.
    var communities: [GraphCommunity]? = nil
}

struct GraphInsights: Decodable {
    struct Totals: Decodable {
        var entities: Int
        var relations: Int
        var mentions: Int
    }

    struct Hub: Decodable, Identifiable {
        var id: String
        var name: String
        var degree: Int
    }

    struct Isolated: Decodable, Identifiable {
        var id: String
        var name: String
    }

    struct TypeCount: Decodable, Identifiable {
        var type: String
        var n: Int
        var id: String { type }
    }

    var totals: Totals
    var hubs: [Hub]
    var isolated: [Isolated]
    var typeCounts: [TypeCount]
}

/// One row of Knowledge → Entities (`GET /api/entities`): a live entity with
/// the numbers that say what it is worth. The JSON is camelCase already, and
/// the `sources` families carry no underscore, so the snake_case decoder
/// leaves every key as it came.
struct EntityItem: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var type: String
    var description: String
    var aliases: [String]
    var wikiPath: String?
    /// Distinct chunks that mention the entity.
    var mentions: Int
    var documents: Int
    /// Live typed relations it takes part in, from either end.
    var relations: Int
    var evidence: Int
    /// Live entity evidence per extractor family: mined, link, wikilink, frontmatter, llm, human, datasource, probe, other.
    var sources: [String: Int]
    /// The survivor this entity was merged into, when it was.
    var canonicalId: String?
    var createdAt: String?
    var updatedAt: String?

    /// What the Updated column sorts by; a missing date sorts first.
    var updatedKey: String { updatedAt ?? "" }
}

/// One page of the entity table, with the type counts of the whole table under the same `merged` setting.
struct EntityPage: Decodable {
    var items: [EntityItem]
    var total: Int
    var offset: Int
    var limit: Int
    var sort: String
    var order: String
    var typeCounts: [GraphInsights.TypeCount]
}

/// An entity a text names, with the spellings the text uses for it (POST /api/entities/mentions).
struct EntityMention: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var type: String
    var wikiPath: String?
    var surfaces: [String]
    var count: Int
}

struct EntityMentionsResponse: Decodable {
    var mentions: [EntityMention]
}

/// One entity at a glance, for the panel a marked name opens (GET /api/entities/detail).
struct EntityDetail: Decodable {
    struct Entity: Decodable, Hashable {
        var id: String
        var name: String
        var type: String
        var description: String
        var aliases: [String]
        var wikiPath: String?
        var mentionCount: Int
        var documentCount: Int
        var degree: Int
    }

    struct Neighbour: Decodable, Hashable, Identifiable {
        var id: String
        var name: String
        var type: String
        var wikiPath: String?
    }

    struct Relation: Decodable, Hashable {
        var type: String
        /// `out` reads entity → other, `in` other → entity.
        var direction: String
        var weight: Double
        var description: String
        var validFrom: String?
        var validTo: String?
    }

    /// Every relation with one neighbour, strongest first.
    struct RelationGroup: Decodable, Hashable, Identifiable {
        var other: Neighbour
        var weight: Double
        var relations: [Relation]

        var id: String { other.id }
    }

    /// An entity its documents mention alongside it, with no typed relation between them.
    struct CoMention: Decodable, Hashable, Identifiable {
        var id: String
        var name: String
        var type: String
        var wikiPath: String?
        var documents: Int
        var chunks: Int
        var weight: Double
    }

    struct Document: Decodable, Hashable, Identifiable {
        var path: String
        var title: String?
        var mentions: Int

        var id: String { path }
    }

    var entity: Entity
    var relations: [RelationGroup]
    var moreRelations: Int
    var cooccurring: [CoMention]
    var claims: [Claim]
    var documents: [Document]
}

struct TraceItem: Decodable, Identifiable, Hashable {
    var id: String
    var source: String
    var sessionId: String?
    var path: String
    var project: String?
    var startedAt: String?
    var bytes: Int
    var sha256: String
    var analyzedAt: String?
}

struct TraceSyncResponse: Decodable {
    var copied: Int
    var skills: Int
}

struct Suggestion: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var evidence: [String]
    var status: String
    var reportPath: String?
    var createdAt: String
}

struct DreamResponse: Decodable {
    var reportPath: String
    var sessions: Int
    var suggestions: [Suggestion]
}

struct IngestStats: Codable {
    var scanned: Int?
    var indexed: Int
    var unchanged: Int
    var removed: Int?
    var skipped: Int?
    var errors: Int?
    var chunks: Int
    var entities: Int?
    var relations: Int?
}

struct UploadResponse: Decodable {
    var ok: Bool
    var saved: [String]
}

/// One file in a multipart upload. `name` is the path relative to the
/// destination directory, so a folder upload keeps its subtree ("notes/2026/kickoff.md").
struct UploadItem {
    var name: String
    var url: URL
}

struct ActionResponse: Decodable {
    var ok: Bool
}

/// What a pass over the configured datasources did (`POST /api/datasources/sync`).
struct DatasourceSyncResponse: Decodable {
    var sources: Int
    var wikiPages: Int
    var errors: [String]
}

/// What the service says a person should know about the workspace
/// (`GET /api/notices`, src/server/notices.ts): data, not sentences — the app
/// words each kind in the interface language. `id` is the kind, of which there
/// is at most one; `key` changes when the notice says something new.
struct NoticesResponse: Decodable {
    var notices: [WorkspaceNotice]
}

struct WorkspaceNotice: Decodable, Identifiable, Hashable {
    /// lint, traces-off, purpose, initialize or datasources.
    var id: String
    var key: String
    /// info or warn.
    var level: String
    // lint: the newest report, and the one before it
    var report: String?
    var date: String?
    var summary: LintSummary?
    var previous: LintPrevious?
    // traces-off: what collecting would copy
    var sessions: Int?
    var bytes: Int?
    // purpose: the file to write
    var path: String?
    // initialize: which of the two exist already
    var overview: Bool?
    var guide: Bool?
    // datasources: the last pass
    var at: String?
    var sources: Int?
    var errors: [String]?
}

/// A lint report's counts, as its summary line states them.
struct LintSummary: Decodable, Hashable {
    var pages: Int
    var findings: Int
    var counts: LintCounts
}

/// The kinds of finding (the service's LintKind; the decoder turns `broken_link` into `brokenLink`).
struct LintCounts: Decodable, Hashable {
    var orphan: Int?
    var brokenLink: Int?
    var staleResearch: Int?
    var unreviewed: Int?
    var expired: Int?
    var supersededText: Int?
    var openDispute: Int?
}

struct LintPrevious: Decodable, Hashable {
    var date: String
    var summary: LintSummary
}

/// playbooks/ as Settings edits it (`GET /api/playbooks`, src/fs/playbooks.ts).
struct PlaybooksResponse: Decodable {
    var groups: [PlaybookGroup]
}

struct PlaybookGroup: Decodable, Identifiable, Hashable {
    /// research, phases, packs, intents, ontology, concepts, capabilities, chat, agents, profiles or sources.
    var id: String
    var dir: String
    /// providers, research or sources: the page that edits the whole group, files or none.
    var managedIn: String?
    var files: [PlaybookFile]
}

struct PlaybookFile: Decodable, Identifiable, Hashable {
    var id: String { path }
    var path: String
    var name: String
    var bytes: Int
    var mtime: String
    /// knode-os ships a version of the file: a reset writes it back.
    var builtin: Bool
    /// The file differs from that version.
    var modified: Bool
    /// knode-os regenerates the file, so an edit would not last.
    var readonly: Bool
    /// providers, research or sources: the page that edits the file instead.
    var managedIn: String?
}

/// One playbook with its text, as reading, saving and resetting return it.
struct PlaybookText: Decodable {
    var file: PlaybookFile
    var text: String

    private enum CodingKeys: String, CodingKey { case text }

    init(from decoder: Decoder) throws {
        file = try PlaybookFile(from: decoder)
        text = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .text)
    }
}

/// One pre-flight step of an initialization (index, extract, regenerate, survey).
struct InitStep: Decodable, Identifiable, Hashable {
    var name: String
    var status: String
    var detail: String?

    var id: String { name }
}

/// One agent session of a team run, as the runner recorded it.
struct PhaseRecord: Decodable, Identifiable, Hashable {
    var name: String
    var label: String
    var role: String?
    var agent: String?
    var turns: Int?
    var error: String?

    var id: String { label }
}

/// A page an initialization decided is worth its own research job.
struct InitTopic: Decodable, Identifiable, Hashable {
    var kind: String
    var target: String
    var why: String?
    var queued: String?

    var id: String { "\(kind):\(target)" }
}

/// The parts of a job's payload the client shows.
struct ResearchJobPayload: Decodable, Hashable {
    var steps: [InitStep]?
    var phases: [PhaseRecord]?
    var topics: [InitTopic]?
    var followUps: [String]?
    var warnings: [String]?
}

struct ResearchJob: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var target: String?
    var query: String?
    var status: String
    var agent: String?
    var outputPath: String?
    var error: String?
    var turns: Int?
    var createdAt: String
    var startedAt: String?
    var finishedAt: String?
    var payload: ResearchJobPayload?
    /// Present on the job-detail route, which also reads the run directory.
    var steps: [InitStep]?
    var phases: [PhaseRecord]?

    var subject: String { target ?? query ?? "" }
    /// Queued, running or validating — the UI keeps polling.
    var isLive: Bool { status == "queued" || status == "running" || status == "validating" }
    var initSteps: [InitStep] { steps?.isEmpty == false ? steps! : payload?.steps ?? [] }
    var initPhases: [PhaseRecord] { phases?.isEmpty == false ? phases! : payload?.phases ?? [] }
    var initTopics: [InitTopic] { payload?.topics ?? [] }
}

/// What `GET /api/survey` reports, narrowed to what the initialization card shows.
struct KbSurvey: Decodable, Hashable {
    struct Stats: Decodable, Hashable {
        var documents: Int
        var chunks: Int
        var entities: Int
        var relations: Int
        var claims: Int
    }

    struct Extraction: Decodable, Hashable {
        var queued: Int
        var llmEnabled: Bool
    }

    struct Guide: Decodable, Hashable {
        struct Stamp: Decodable, Hashable {
            var job: String
            var at: String
            var agent: String
        }

        var exists: Bool
        var path: String
        var bytes: Int
        var updatedAt: String?
        var stamp: Stamp?
    }

    var stats: Stats
    var extraction: Extraction
    var guide: Guide
}

struct InitStatus: Decodable {
    var survey: KbSurvey
    var guide: KbSurvey.Guide
    var job: ResearchJob?
    var followUps: [ResearchJob]
}

struct ResearchPage: Decodable, Identifiable, Hashable {
    var id: String { path }
    var path: String
    var exists: Bool
    var job: String
    var kind: String
    var target: String?
    var agent: String?
    var finishedAt: String?
    var trust: String?
    var warnings: [String]?
}

struct ResearchRecommendation: Decodable, Identifiable, Hashable {
    var id: String { "\(kind)|\(target)" }
    var kind: String
    var target: String
    var score: Double
    var reasons: [String]
    var suggestionId: String?
}

struct QueueResearchResponse: Decodable {
    var job: ResearchJob
    var created: Bool
}

struct TrustResponse: Decodable {
    var key: String
    var from: String
    var to: String
}

struct EmbeddingConfig: Codable, Equatable {
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var dimensions: Int
    var batchSize: Int?
    var sendDimensions: Bool
}

/// One configured embedding provider. Only one is active at a time — vectors
/// from two models do not share a space — so `KnodeConfig.embeddingUse` names
/// the one the Index stage runs on, and switching re-embeds the corpus.
struct EmbeddingConnection: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var dimensions: Int
    var batchSize: Int?
    var sendDimensions: Bool
    var enabled: Bool?
    var priority: Int?
    var quotaGroup: String?
    var limits: EmbeddingLimits?
    var limitNote: String?
    var catalog: [String]?
    var upstream: String?

    init(id: String, label: String, provider: String = "openai") {
        self.id = id
        self.label = label
        self.provider = provider
        baseUrl = provider == "openai" ? "https://api.openai.com/v1" : ""
        apiKey = ""
        model = ""
        dimensions = provider == "local" ? 384 : 1536
        batchSize = nil
        sendDimensions = false
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? id
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "local"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        dimensions = try container.decodeIfPresent(Int.self, forKey: .dimensions) ?? 384
        batchSize = try container.decodeIfPresent(Int.self, forKey: .batchSize)
        sendDimensions = try container.decodeIfPresent(Bool.self, forKey: .sendDimensions) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
        priority = try container.decodeIfPresent(Int.self, forKey: .priority)
        quotaGroup = try container.decodeIfPresent(String.self, forKey: .quotaGroup)
        limits = try container.decodeIfPresent(EmbeddingLimits.self, forKey: .limits)
        limitNote = try container.decodeIfPresent(String.self, forKey: .limitNote)
        catalog = try container.decodeIfPresent([String].self, forKey: .catalog)
        upstream = try container.decodeIfPresent(String.self, forKey: .upstream)
    }
}

struct EmbeddingLimits: Codable, Equatable {
    var requestsPerMinute = 60
    var tokensPerMinute = 100_000
    var requestsPerDay = 5_000
    var tokensPerDay = 1_000_000
    var concurrency = 2
    var resetTimezone = "UTC"
}

struct EmbeddingPoolConfig: Codable, Equatable {
    var enabled = false
    var model = "bge-m3"
    var dimensions = 1024
    var batchSize = 16
}

struct EmbeddingUsageResponse: Decodable {
    var entries: [EmbeddingUsage]
}

struct EmbeddingUsage: Decodable, Identifiable {
    var id: String
    var requestsToday: Int
    var tokensToday: Int
    var estimatedTokensToday: Int?
    var requestsThisMinute: Int
    var inFlight: Int
    var cooldownUntil: Double?
    var lastError: String?
    var lastSuccess: Double?
}

struct EmbeddingTestResponse: Decodable {
    var ok: Bool
    var model: String?
    var dimensions: Int?
    var ms: Int?
    var error: String?
}

struct LLMConfig: Codable, Equatable {
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    /// How hard a CLI provider thinks. "default" leaves the CLI's own setting
    /// alone, and an OpenAI-compatible endpoint ignores it.
    var effort: String
    var cliTimeoutMs: Int?
    /// Shown in the providers table. Empty = the provider's own name.
    var label: String?

    /// Decoded field by field so a service that predates one of them — `effort`
    /// arrived after the rest — still yields a usable config instead of failing.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "openai"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
        label = try container.decodeIfPresent(String.self, forKey: .label)
    }
}

/// A pipeline route. `use` names the connection it runs on — empty for the
/// default provider — and `model`, `effort` and `speed` override that
/// target's own ("default" keeps the target's). The remaining fields only
/// carry pre-connections configs the service migrates.
struct RoutedLLMConfig: Codable, Equatable {
    var use: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    var effort: String
    var speed: String
    var cliTimeoutMs: Int?

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        use = try container.decodeIfPresent(String.self, forKey: .use) ?? ""
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "inherit"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        speed = try container.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
    }
}

/// A named endpoint plus credentials that any number of routes can point at.
struct LLMConnection: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    /// See `LLMConfig.effort`.
    var effort: String
    /// "fast" = codex's priority tier; "default" leaves the CLI's own. Only a
    /// CLI agent standing in as a target carries anything else.
    var speed: String
    var cliTimeoutMs: Int?

    init(id: String, label: String, provider: String = "openai") {
        self.id = id
        self.label = label
        self.provider = provider
        baseUrl = provider == "openai" ? "https://api.openai.com/v1" : ""
        apiKey = ""
        model = ""
        cliPath = ""
        effort = "default"
        speed = "default"
        cliTimeoutMs = nil
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? id
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "openai"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        speed = try container.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
    }
}

/// The per-stage rates the pipeline runs at. The service owns the rest of its
/// `ingest` block (chunk size, watch); those fields are left out deliberately,
/// and it keeps whatever this client does not send.
/// An OpenAI-compatible embeddings endpoint on the service's machine, for its
/// embed slots (`ingest.embedEndpoint`, docs/design/12 §4.3). The service
/// takes its vectors only once they pass calibration against the pool's.
struct EmbedEndpointConfig: Codable, Equatable {
    var baseUrl: String
    var model: String
    /// Optional; "***" from the service means "keep the saved one".
    var apiKey: String?
}

struct IngestConfig: Codable, Equatable {
    /// Parallel documents in flight during the index pass.
    var concurrency: Int
    /// Parallel document conversions in the prepare pass.
    var convertConcurrency: Int
    /// "inline" (vectors while syncing) or "deferred" (embed slots fill them in after).
    var embedding: String
    /// The service's own embed slots in deferred mode.
    var embedSlots: Int
    /// Nil: none. Sent as null then, which removes a saved one.
    var embedEndpoint: EmbedEndpointConfig?

    enum CodingKeys: String, CodingKey {
        case concurrency, convertConcurrency, embedding, embedSlots, embedEndpoint
    }

    init(concurrency: Int = 4, convertConcurrency: Int = 2, embedding: String = "inline", embedSlots: Int = 8, embedEndpoint: EmbedEndpointConfig? = nil) {
        self.concurrency = concurrency
        self.convertConcurrency = convertConcurrency
        self.embedding = embedding
        self.embedSlots = embedSlots
        self.embedEndpoint = embedEndpoint
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = IngestConfig()
        concurrency = try container.decodeIfPresent(Int.self, forKey: .concurrency) ?? fallback.concurrency
        convertConcurrency = try container.decodeIfPresent(Int.self, forKey: .convertConcurrency) ?? fallback.convertConcurrency
        embedding = try container.decodeIfPresent(String.self, forKey: .embedding) ?? fallback.embedding
        embedSlots = try container.decodeIfPresent(Int.self, forKey: .embedSlots) ?? fallback.embedSlots
        embedEndpoint = try container.decodeIfPresent(EmbedEndpointConfig.self, forKey: .embedEndpoint)
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(concurrency, forKey: .concurrency)
        try container.encode(convertConcurrency, forKey: .convertConcurrency)
        try container.encode(embedding, forKey: .embedding)
        try container.encode(embedSlots, forKey: .embedSlots)
        // an explicit null removes the endpoint; a missing key would keep it
        try container.encode(embedEndpoint, forKey: .embedEndpoint)
    }
}

/// `POST /api/config/embedding-endpoint/check`: the probe set embedded on the endpoint, against the pool's vectors.
struct EmbedEndpointCheck: Decodable {
    var ok: Bool
    var reason: String?
    var error: String?
    var vectorModel: String?
    var endpointModel: String?
    var minCosine: Double?
    var meanCosine: Double?
    var threshold: Double?
    var ms: Int?
}

struct ExtractionConfig: Codable, Equatable {
    var claims: Bool
    var entityLlm: RoutedLLMConfig
    var documentLlm: RoutedLLMConfig
    /// The Summarize stage: one summary page per document, written in the
    /// background pass right after extraction.
    var summaryLlm: RoutedLLMConfig
    /// The Judge stage: knode_ask, Dream, the duplicate-entity review after
    /// each extraction pass and the disputed-claim review.
    var judgeLlm: RoutedLLMConfig
    /// The Translate stage: documents into the content languages, segment by
    /// segment. A service from before it sends none, and starts its own as a
    /// copy of the Summarize route (`migrateTranslateRoute`) — so does this
    /// mirror, which keeps the stage's form one shape either way.
    var translateLlm: RoutedLLMConfig
    /// Model calls per background pass: extraction calls (a long document
    /// takes one per segment) and, separately, summaries.
    var batchSize: Int
    /// Parallel model calls in a background pass, for both.
    var concurrency: Int
    /// This machine's translation slots; nil follows `concurrency`, and 0
    /// leaves translations to remote workers.
    var translateConcurrency: Int?
    /// Longest text one extraction call reads (characters); a longer document
    /// is read in segments. File-only — shown, never sent back as a change.
    var segmentChars: Int?

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        claims = try container.decode(Bool.self, forKey: .claims)
        entityLlm = try container.decode(RoutedLLMConfig.self, forKey: .entityLlm)
        documentLlm = try container.decode(RoutedLLMConfig.self, forKey: .documentLlm)
        summaryLlm = try container.decode(RoutedLLMConfig.self, forKey: .summaryLlm)
        judgeLlm = try container.decode(RoutedLLMConfig.self, forKey: .judgeLlm)
        translateLlm = try container.decodeIfPresent(RoutedLLMConfig.self, forKey: .translateLlm) ?? summaryLlm
        batchSize = try container.decode(Int.self, forKey: .batchSize)
        concurrency = try container.decode(Int.self, forKey: .concurrency)
        translateConcurrency = try container.decodeIfPresent(Int.self, forKey: .translateConcurrency)
        segmentChars = try container.decodeIfPresent(Int.self, forKey: .segmentChars)
    }
}

/// The workspace's content languages (`languages` in knode.config.json,
/// docs/design/17): the primary language the knowledge is read in, which
/// every other document is translated into in the background, and the
/// secondary ones a reader may ask for. Not the interface language, which is
/// each person's own and never part of the workspace.
struct LanguagesConfig: Codable, Equatable {
    /// Off: nothing is translated, summaries keep the document's language,
    /// readers see no switcher.
    var enabled: Bool
    /// A code from the service's catalog; empty = not chosen yet, which the
    /// service refuses together with `enabled`.
    var primary: String
    var secondary: [String]
    /// Longest document translated without a request, in characters; 0 = no limit.
    var maxChars: Int

    init(enabled: Bool = false, primary: String = "", secondary: [String] = [], maxChars: Int = 200_000) {
        self.enabled = enabled
        self.primary = primary
        self.secondary = secondary
        self.maxChars = maxChars
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = LanguagesConfig()
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? fallback.enabled
        primary = try container.decodeIfPresent(String.self, forKey: .primary) ?? fallback.primary
        secondary = try container.decodeIfPresent([String].self, forKey: .secondary) ?? fallback.secondary
        maxChars = try container.decodeIfPresent(Int.self, forKey: .maxChars) ?? fallback.maxChars
    }
}

/// What the Judge stage does with its verdicts: the service's `review.llmJudge`,
/// `review.claims` and `review.claimMerge`. The thresholds stay in the config
/// file, and the service keeps every key this client does not send.
struct ReviewConfig: Codable, Equatable {
    /// "off" | "suggest" | "auto" — auto merges pairs judged the same with
    /// high confidence; a merge can always be undone.
    var llmJudge: String
    /// "off" | "suggest"
    var claims: String
    /// Duplicate claims: "off" | "suggest" | "auto" — auto merges identical
    /// wordings and pairs judged the same with high confidence; undoable.
    var claimMerge: String
    /// The workspace's web switch, for research jobs and Ask alike:
    /// "off" | "verify" (verification jobs, and agents set to on) | "research"
    /// (every job). Edited on the Research tab.
    var external: String

    init(llmJudge: String = "suggest", claims: String = "suggest", claimMerge: String = "auto", external: String = "verify") {
        self.llmJudge = llmJudge
        self.claims = claims
        self.claimMerge = claimMerge
        self.external = external
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ReviewConfig()
        llmJudge = try container.decodeIfPresent(String.self, forKey: .llmJudge) ?? fallback.llmJudge
        claims = try container.decodeIfPresent(String.self, forKey: .claims) ?? fallback.claims
        claimMerge = try container.decodeIfPresent(String.self, forKey: .claimMerge) ?? fallback.claimMerge
        external = try container.decodeIfPresent(String.self, forKey: .external) ?? fallback.external
    }
}

/// The runner half of the service's `research` block: which coding-agent CLI
/// writes wiki pages, how many run at once, and which profile they follow. The
/// service merges what it receives into its own block, so the fields this
/// client does not model (runsDir, keepRuns, readDirs) keep their values.
struct ResearchConfig: Codable, Equatable {
    struct Auto: Codable, Equatable {
        var enabled: Bool
        var dailyJobs: Int
    }

    /// What the Wiki tab's initialize button does around its agent run. It
    /// always first extracts what the tier-1 queue still holds; the cap on
    /// that is edited with the Extract stage under Ingest, the follow-ups in
    /// the Research runner card.
    struct Initialization: Codable, Equatable {
        /// Topic pages queued as follow-up research jobs.
        var followUps: Int
        /// How long the catch-up extraction may run before the agent starts.
        var extractionMaxMs: Int

        init(followUps: Int = 6, extractionMaxMs: Int = 900_000) {
            self.followUps = followUps
            self.extractionMaxMs = extractionMaxMs
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let fallback = Initialization()
            followUps = try container.decodeIfPresent(Int.self, forKey: .followUps) ?? fallback.followUps
            extractionMaxMs = try container.decodeIfPresent(Int.self, forKey: .extractionMaxMs) ?? fallback.extractionMaxMs
        }
    }

    /// A connection id or a CLI provider name; empty follows the default LLM
    /// provider when that is itself a CLI.
    var agent: String
    var model: String
    var profile: String
    /// "team" | "native" | "single" for a profile that names none. Settings
    /// edits the pipeline on the profile, so this only round-trips.
    var pipeline: String
    /// The turn cap for a template that sets none — every built-in one does.
    /// Not edited here; the roles carry their own.
    var maxTurns: Int
    /// One agent session's limit; a team job runs several.
    var timeoutMs: Int
    var concurrency: Int
    /// What a research role with no `parallel` of its own runs at.
    var researchers: Int
    /// What a revise role with no `rounds` of its own runs at.
    var reviewRounds: Int
    var auto: Auto
    var initialization: Initialization

    enum CodingKeys: String, CodingKey {
        case agent, model, profile, pipeline, maxTurns, timeoutMs, concurrency, researchers, reviewRounds, auto
        case initialization = "init"
    }

    init(
        agent: String = "",
        model: String = "",
        profile: String = "default",
        pipeline: String = "team",
        maxTurns: Int = 40,
        timeoutMs: Int = 1_200_000,
        concurrency: Int = 1,
        researchers: Int = 3,
        reviewRounds: Int = 1,
        auto: Auto = Auto(enabled: false, dailyJobs: 3),
        initialization: Initialization = Initialization()
    ) {
        self.agent = agent
        self.model = model
        self.profile = profile
        self.pipeline = pipeline
        self.maxTurns = maxTurns
        self.timeoutMs = timeoutMs
        self.concurrency = concurrency
        self.researchers = researchers
        self.reviewRounds = reviewRounds
        self.auto = auto
        self.initialization = initialization
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ResearchConfig()
        agent = try container.decodeIfPresent(String.self, forKey: .agent) ?? fallback.agent
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? fallback.model
        profile = try container.decodeIfPresent(String.self, forKey: .profile) ?? fallback.profile
        pipeline = try container.decodeIfPresent(String.self, forKey: .pipeline) ?? fallback.pipeline
        maxTurns = try container.decodeIfPresent(Int.self, forKey: .maxTurns) ?? fallback.maxTurns
        timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs) ?? fallback.timeoutMs
        concurrency = try container.decodeIfPresent(Int.self, forKey: .concurrency) ?? fallback.concurrency
        researchers = try container.decodeIfPresent(Int.self, forKey: .researchers) ?? fallback.researchers
        reviewRounds = try container.decodeIfPresent(Int.self, forKey: .reviewRounds) ?? fallback.reviewRounds
        auto = try container.decodeIfPresent(Auto.self, forKey: .auto) ?? fallback.auto
        initialization = try container.decodeIfPresent(Initialization.self, forKey: .initialization) ?? fallback.initialization
    }
}

/// The chat entry's settings (`chat` in knode.config.json).
struct ChatConfig: Codable, Equatable {
    /// Connection id or CLI provider; empty follows the research agent.
    var agent: String
    var model: String
    var historyTurns: Int
    var keep: Int

    init(
        agent: String = "default",
        model: String = "",
        historyTurns: Int = 12,
        keep: Int = 200
    ) {
        self.agent = agent
        self.model = model
        self.historyTurns = historyTurns
        self.keep = keep
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ChatConfig()
        agent = try container.decodeIfPresent(String.self, forKey: .agent) ?? fallback.agent
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? fallback.model
        historyTurns = try container.decodeIfPresent(Int.self, forKey: .historyTurns) ?? fallback.historyTurns
        keep = try container.decodeIfPresent(Int.self, forKey: .keep) ?? fallback.keep
    }
}

struct KnodeConfig: Codable, Equatable {
    /// The active embedding provider, flattened by the service from
    /// `embeddingProviders`. Read-only here: the table edits the list.
    var embedding: EmbeddingConfig
    var embeddingProviders: [EmbeddingConnection]
    /// Which `embeddingProviders` entry the Index stage runs on.
    var embeddingUse: String
    var embeddingPool: EmbeddingPoolConfig?
    /// A mirror of the connection `llmUse` names, flattened by the service.
    /// Read-only here: the table edits the list, like the embedding one.
    var llm: LLMConfig
    var connections: [LLMConnection]
    /// Which `connections` entry every job inherits unless it names another.
    var llmUse: String
    var ingest: IngestConfig
    var extraction: ExtractionConfig
    var review: ReviewConfig
    var research: ResearchConfig
    var chat: ChatConfig
    /// Nil from a service that predates content languages: it has no
    /// Translate stage either, and the form says so instead of offering one.
    var languages: LanguagesConfig?

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        embedding = try container.decode(EmbeddingConfig.self, forKey: .embedding)
        embeddingProviders = try container.decodeIfPresent([EmbeddingConnection].self, forKey: .embeddingProviders) ?? []
        embeddingUse = try container.decodeIfPresent(String.self, forKey: .embeddingUse) ?? ""
        embeddingPool = try container.decodeIfPresent(EmbeddingPoolConfig.self, forKey: .embeddingPool)
        llm = try container.decode(LLMConfig.self, forKey: .llm)
        connections = try container.decodeIfPresent([LLMConnection].self, forKey: .connections) ?? []
        llmUse = try container.decodeIfPresent(String.self, forKey: .llmUse) ?? ""
        ingest = try container.decodeIfPresent(IngestConfig.self, forKey: .ingest) ?? IngestConfig()
        extraction = try container.decode(ExtractionConfig.self, forKey: .extraction)
        review = try container.decodeIfPresent(ReviewConfig.self, forKey: .review) ?? ReviewConfig()
        research = try container.decodeIfPresent(ResearchConfig.self, forKey: .research) ?? ResearchConfig()
        chat = try container.decodeIfPresent(ChatConfig.self, forKey: .chat) ?? ChatConfig()
        languages = try container.decodeIfPresent(LanguagesConfig.self, forKey: .languages)
    }

    /// The entry the Index stage runs on, or nil while the list is still loading.
    var activeEmbedding: EmbeddingConnection? {
        embeddingProviders.first { $0.id == embeddingUse } ?? embeddingProviders.first
    }

    /// The connection every job inherits, or nil while the list is still loading.
    var activeLlm: LLMConnection? {
        connections.first { $0.id == llmUse } ?? connections.first
    }
}

/// The coding-agent CLIs. They are agents that bring their own loop, so they
/// live in the agents table, not among the models.
let cliProviderNames = ["claude-cli", "codex-cli", "cursor-cli"]

/// A named agent: who runs a research job or a chat turn, and how hard they
/// think. How the research itself is conducted stays in the profile.
struct AgentDefinition: Codable, Equatable, Identifiable {
    /// Web tools in Ask, within `review.external`. Ask's turn cap, timeout,
    /// page and file tools are its own, the same for every agent.
    struct Tools: Codable, Equatable {
        /// "inherit" | "on" | "off"
        var web: String

        init(web: String = "inherit") {
            self.web = web
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            web = try container.decodeIfPresent(String.self, forKey: .web) ?? Tools().web
        }
    }

    var name: String
    var title: String
    /// A CLI provider name runs that CLI; "default" or a connection id runs
    /// the built-in deepagents loop on that model.
    var executor: String
    /// A CLI agent's executable; "" = the CLI's own name on PATH.
    var cliPath: String
    var model: String
    var effort: String
    /// "fast" = codex's priority tier; the other CLIs ignore it.
    var speed: String
    var tools: Tools
    var path: String
    /// Server-reported, never sent back.
    var builtin: Bool
    var runnable: Bool

    var id: String { name }

    init(name: String, executor: String = "default") {
        self.name = name
        title = name
        self.executor = executor
        cliPath = ""
        model = ""
        effort = "default"
        speed = "default"
        tools = Tools()
        path = ""
        builtin = false
        runnable = false
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? name
        executor = try container.decodeIfPresent(String.self, forKey: .executor) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        speed = try container.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        tools = try container.decodeIfPresent(Tools.self, forKey: .tools) ?? Tools()
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        builtin = try container.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
        runnable = try container.decodeIfPresent(Bool.self, forKey: .runnable) ?? false
    }

    /// What `PUT /api/agents/:name` takes: the server owns `builtin`/`runnable`/`path`.
    struct Payload: Encodable {
        var title: String
        var executor: String
        var cliPath: String
        var model: String
        var effort: String
        var speed: String
        var tools: Tools
    }

    var payload: Payload {
        Payload(title: title, executor: executor, cliPath: cliPath, model: model, effort: effort, speed: speed, tools: tools)
    }

    /// Runs a coding-agent CLI, rather than deepagents on a model.
    var isCli: Bool { cliProviderNames.contains(executor) }

    /// A CLI agent as a pipeline stage or the default sees it: a one-shot LLM.
    /// The client-side mirror of the service's `readAgentLlms`.
    var asLlmTarget: LLMConnection? {
        guard isCli else { return nil }
        var target = LLMConnection(id: name, label: title.trimmingCharacters(in: .whitespaces).isEmpty ? name : title, provider: executor)
        target.model = model
        target.cliPath = cliPath
        target.effort = effort
        target.speed = speed
        return target
    }

    /// An agent as a pipeline stage sees it, run once through its own loop: a
    /// CLI agent as `asLlmTarget`, a deepagents agent as the endpoint it runs
    /// on, with its own model or else the endpoint's — the service runs the
    /// deepagents loop there, which is what sets it apart from that endpoint's
    /// row. Nil for one that runs on nothing: it follows a default that is a
    /// CLI agent, or names a model endpoint that is gone. The client-side
    /// mirror of the service's `routeTargets`.
    func asRouteTarget(connections: [LLMConnection], defaultTarget: LLMConnection?) -> LLMConnection? {
        if isCli { return asLlmTarget }
        let endpoint = executor == "default" ? defaultTarget : connections.first { $0.id == executor }
        guard var target = endpoint, !cliProviderNames.contains(target.provider) else { return nil }
        target.id = name
        target.label = title.trimmingCharacters(in: .whitespaces).isEmpty ? name : title
        if !model.isEmpty { target.model = model }
        return target
    }
}

struct AgentsResponse: Decodable {
    var active: String
    var chat: String
    var agents: [AgentDefinition]
}

struct DeleteAgentResponse: Decodable {
    var ok: Bool
    var reset: Bool?
}

/* ------------------------------ chat ---------------------------------- */

/// One tool call a chat turn made, or a file the reply wrote.
struct ChatEvent: Decodable, Hashable, Identifiable {
    var tool: String
    var summary: String
    var path: String?
    var ok: Bool?

    var id: String { "\(tool)|\(summary)|\(path ?? "")" }
    var label: String { tool == "wrote" ? "wrote \(summary)" : summary.isEmpty ? tool : "\(tool): \(summary)" }
}

/// Whether a question asked now would be answered, and if not, why. `reason`
/// matches the one the send path returns, so both land on the same screen.
struct ChatReadiness: Decodable {
    var ready: Bool
    var reason: String?
    var hint: String?
    var provider: String?
    var model: String?
}

struct ChatMessage: Decodable, Identifiable, Hashable {
    var id: String
    var seq: Int
    var role: String
    var content: String
    var events: [ChatEvent]
    var turns: Int?
    var error: String?
    var createdAt: String

    var isUser: Bool { role == "user" }
}

struct ChatConversation: Decodable, Identifiable, Hashable {
    var id: String
    var title: String
    var status: String
    var agent: String?
    var updatedAt: String
    var messages: [ChatMessage]?
    var running: Bool?

    @MainActor var displayTitle: String { title.isEmpty ? L("(untitled)") : title }
}

struct ChatStatusResponse: Decodable {
    var status: String
    var seq: Int?
    var activity: [ChatEvent]
}

struct ChatSendResponse: Decodable {
    var ok: Bool
    var seq: Int
    /// `running` means a session started and must be polled until it is idle.
    var status: String
}

struct ChatProtocolResponse: Decodable {
    var path: String
    var text: String
}

struct RouteTestResult: Decodable {
    var ok: Bool
    var enabled: Bool?
    var inherited: Bool?
    var note: String?
    var error: String?
    var provider: String?
    var model: String?
    var dimensions: Int?
    var sample: String?
    var ms: Int?
}

struct ConfigTestResponse: Decodable {
    var embedding: RouteTestResult?
    var llm: RouteTestResult?
    var entityLlm: RouteTestResult?
    var documentLlm: RouteTestResult?
    var summaryLlm: RouteTestResult?
    var judgeLlm: RouteTestResult?
    var translateLlm: RouteTestResult?
}

/// One entry of what a provider offers for a `model` field. The field itself
/// stays free text — this is a shortcut, not a closed set.
struct ModelOption: Decodable, Identifiable, Hashable {
    var id: String
    var label: String?
    /// The reasoning efforts it accepts, lowest first — only when the
    /// provider says (codex's catalog). Nil = unknown: the CLI's own ladder.
    var efforts: [EffortOption]?
    /// The level it runs at when none is set.
    var defaultEffort: String?
    /// Speeds beyond standard it offers, e.g. codex's Fast tier.
    var speeds: [SpeedOption]?
}

struct EffortOption: Decodable, Hashable {
    var id: String
    var description: String?
}

struct SpeedOption: Decodable, Hashable {
    var id: String
    var name: String?
    var description: String?
}

struct ModelListResponse: Decodable {
    /// "api" — the provider listed them; "cli" — the CLI did; "builtin" — knode's own hints.
    var source: String
    var ok: Bool
    var models: [ModelOption]
    var command: String?
    var resolvedPath: String?
    var note: String?
    var error: String?
    /// True when the service answered from its own cache rather than the provider.
    var cached: Bool?
    var cachedAt: String?
    /// What the CLI runs when nothing is named, from its own config file.
    var defaults: CliDefaults?
}

/// A CLI's own defaults (codex's `~/.codex/config.toml`), so an empty model
/// field or a "default" effort can show what it comes to.
struct CliDefaults: Decodable, Hashable {
    var model: String?
    var effort: String?
    /// "fast" when the CLI asks for its priority tier on its own.
    var speed: String?
}

/**
 * The model lists this screen has already fetched, shared by every picker on
 * it. Without it each `ModelField` kept its own copy: the same provider was
 * asked once per field, and every list was thrown away when the view went
 * away. The service caches by endpoint underneath, so this only has to stop
 * the round trip, not the work behind it.
 */
@MainActor
final class ModelCatalog: ObservableObject {
    @Published private(set) var lists: [String: ModelListResponse] = [:]
    @Published private(set) var failures: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []

    func list(_ key: String) -> ModelListResponse? { lists[key] }
    func failure(_ key: String) -> String? { failures[key] }
    func isLoading(_ key: String) -> Bool { loading.contains(key) }

    /// Fetch unless it is already held. `refresh` reloads and tells the
    /// service to ask the provider again.
    func load(_ key: String, refresh: Bool = false, using fetch: @escaping (Bool) async throws -> ModelListResponse) async {
        if loading.contains(key) { return }
        if !refresh, lists[key] != nil { return }
        loading.insert(key)
        failures[key] = nil
        defer { loading.remove(key) }
        do {
            lists[key] = try await fetch(refresh)
        } catch {
            failures[key] = error.localizedDescription
        }
    }

    /// A provider change invalidates what was fetched from the old one.
    func forget(prefix: String) {
        for key in lists.keys where key.hasPrefix(prefix) { lists[key] = nil }
        for key in failures.keys where key.hasPrefix(prefix) { failures[key] = nil }
    }
}

/// Where a coding-agent CLI resolved to on the service's PATH.
struct CliTool: Decodable, Identifiable {
    var provider: String
    var command: String
    var path: String?
    var id: String { provider }
}

struct CliToolsResponse: Decodable {
    var tools: [CliTool]
}

/// What can run a session here, and what to preselect when nothing is set.
struct AvailableAgent: Decodable, Identifiable {
    var id: String
    var kind: String
    var label: String
    var available: Bool
    var reason: String?
}

struct AvailableAgentsResponse: Decodable {
    var agents: [AvailableAgent]
    var suggested: String?
}

struct ConfigSaveResponse: Decodable {
    var ok: Bool
    var config: KnodeConfig
    var reembedded: Bool
    var reconverted: Bool?
    var reindex: IngestStats?
}

/* ------------------------- deep research profiles ------------------------ */

/// A sub-agent inside a profile: which phase it covers, the CLI and model it
/// runs on, the tools it may use and the prompt it is given. `prompt*` fields
/// are what the service resolved for display — they are sent back in the PUT's
/// own `prompts` map, never inside the profile, so `encode` leaves them out.
struct ResearchRole: Codable, Equatable, Identifiable {
    struct Tools: Codable, Equatable {
        /// knode_write / knode_commit — the role writes pages.
        var write: Bool
        /// Read / Grep / Glob over the read-only add-dirs.
        var files: Bool
        /// "inherit" (the profile's search.web) | "on" | "off"; review.external still caps it.
        var web: String
    }

    var id: String
    var title: String
    /// plan | research | synthesize | review | revise
    var phase: String
    var enabled: Bool
    /// Connection id or provider name; empty = the research agent.
    var agent: String
    var model: String
    /// "default" = the profile's reasoning effort.
    var effort: String
    /// "default" = the profile's speed; "fast" = codex's priority tier.
    var speed: String
    var tools: Tools
    /// research phase: parallel sessions (0 = `research.researchers`).
    var parallel: Int
    /// revise phase: review → revise rounds (0 = `research.reviewRounds`).
    /// A review role's own is the older spelling, read only while no reviser
    /// sets one; Settings no longer shows it there.
    var rounds: Int
    /// 0 = the page template's cap.
    var maxTurns: Int
    /// Prompt file relative to playbooks/research/ ("" = the phase default).
    var prompt: String
    /// Offered to the orchestrator as a native sub-agent when pipeline = native.
    var native: Bool
    var description: String

    var promptPath: String
    var promptText: String
    var promptIsDefault: Bool
    var promptDefault: String

    private enum CodingKeys: String, CodingKey {
        case id, title, phase, enabled, agent, model, effort, speed, tools, parallel, rounds, maxTurns, prompt, native, description
        case promptPath, promptText, promptIsDefault, promptDefault
    }

    init(id: String, phase: String, promptDefault: String) {
        self.id = id
        title = "New role"
        self.phase = phase
        enabled = true
        agent = ""
        model = ""
        effort = "default"
        speed = "default"
        tools = Tools(write: phase == "synthesize" || phase == "revise", files: true, web: "inherit")
        parallel = 0
        rounds = 0
        maxTurns = 0
        prompt = ""
        native = false
        description = ""
        promptPath = "playbooks/research/roles/\(id).md"
        promptText = promptDefault
        promptIsDefault = true
        self.promptDefault = promptDefault
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "research"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        agent = try c.decodeIfPresent(String.self, forKey: .agent) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        effort = try c.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        tools = try c.decodeIfPresent(Tools.self, forKey: .tools) ?? Tools(write: false, files: true, web: "inherit")
        parallel = try c.decodeIfPresent(Int.self, forKey: .parallel) ?? 0
        rounds = try c.decodeIfPresent(Int.self, forKey: .rounds) ?? 0
        maxTurns = try c.decodeIfPresent(Int.self, forKey: .maxTurns) ?? 0
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        native = try c.decodeIfPresent(Bool.self, forKey: .native) ?? false
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        promptPath = try c.decodeIfPresent(String.self, forKey: .promptPath) ?? ""
        promptText = try c.decodeIfPresent(String.self, forKey: .promptText) ?? ""
        promptIsDefault = try c.decodeIfPresent(Bool.self, forKey: .promptIsDefault) ?? true
        promptDefault = try c.decodeIfPresent(String.self, forKey: .promptDefault) ?? ""
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(phase, forKey: .phase)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(agent, forKey: .agent)
        try c.encode(model, forKey: .model)
        try c.encode(effort, forKey: .effort)
        try c.encode(speed, forKey: .speed)
        try c.encode(tools, forKey: .tools)
        try c.encode(parallel, forKey: .parallel)
        try c.encode(rounds, forKey: .rounds)
        try c.encode(maxTurns, forKey: .maxTurns)
        try c.encode(prompt, forKey: .prompt)
        try c.encode(native, forKey: .native)
        try c.encode(description, forKey: .description)
    }
}

/// `playbooks/research/profiles/<name>.yaml` as the service resolved it.
struct ResearchProfileDetail: Codable, Equatable {
    struct Reasoning: Codable, Equatable {
        /// default | low | medium | high | xhigh | max | ultra
        var effort: String
        /// default | fast
        var speed: String

        init(effort: String = "default", speed: String = "default") {
            self.effort = effort
            self.speed = speed
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            effort = try c.decodeIfPresent(String.self, forKey: .effort) ?? "default"
            speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        }
    }

    struct Search: Codable, Equatable {
        var web: String
        /// live | cached
        var freshness: String
        var maxRounds: Int
    }

    struct Verification: Codable, Equatable {
        var minSourcesPerClaim: Int
        var preferPrimarySources: Bool
        /// flag | prefer_primary | prefer_recent
        var resolveConflicts: String
    }

    struct Stop: Codable, Equatable {
        var maxSections: Int
        var marginalGain: Bool
    }

    struct Output: Codable, Equatable {
        var citations: Bool
        var uncertainty: Bool
        var evidenceTable: Bool
    }

    var name: String
    var title: String
    var description: String
    /// "team" | "native" | "single"; "" = `research.pipeline`, which the
    /// picker shows and replaces with an explicit value once it is changed.
    var pipeline: String
    var reasoning: Reasoning
    var search: Search
    var verification: Verification
    var stop: Stop
    var output: Output
    var roles: [ResearchRole]
    var path: String
    /// A built-in profile deletes back to its defaults instead of disappearing.
    var builtin: Bool
    /// The prompt each phase falls back to, for "Reset to built-in".
    var phaseDefaults: [String: String]

    private enum CodingKeys: String, CodingKey {
        case name, title, description, pipeline, reasoning, search, verification, stop, output, roles
        case path, builtin, phaseDefaults
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? name
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        pipeline = try c.decodeIfPresent(String.self, forKey: .pipeline) ?? ""
        reasoning = try c.decodeIfPresent(Reasoning.self, forKey: .reasoning) ?? Reasoning(effort: "default")
        search = try c.decodeIfPresent(Search.self, forKey: .search) ?? Search(web: "inherit", freshness: "live", maxRounds: 3)
        verification = try c.decodeIfPresent(Verification.self, forKey: .verification)
            ?? Verification(minSourcesPerClaim: 1, preferPrimarySources: true, resolveConflicts: "flag")
        stop = try c.decodeIfPresent(Stop.self, forKey: .stop) ?? Stop(maxSections: 8, marginalGain: true)
        output = try c.decodeIfPresent(Output.self, forKey: .output) ?? Output(citations: true, uncertainty: true, evidenceTable: false)
        roles = try c.decodeIfPresent([ResearchRole].self, forKey: .roles) ?? []
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        builtin = try c.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
        phaseDefaults = try c.decodeIfPresent([String: String].self, forKey: .phaseDefaults) ?? [:]
    }

    /// What `PUT /api/research/profiles/:name` stores: the profile itself,
    /// without the read-only fields the service derives.
    func payload(name: String? = nil) -> ResearchProfilePayload {
        ResearchProfilePayload(
            name: name ?? self.name,
            title: title,
            description: description,
            pipeline: pipeline,
            reasoning: reasoning,
            search: search,
            verification: verification,
            stop: stop,
            output: output,
            roles: roles
        )
    }

    /// Role prompts travel next to the profile; the service only writes a text
    /// that differs from what the role runs with today.
    var prompts: [String: String] {
        Dictionary(roles.map { ($0.id, $0.promptText) }, uniquingKeysWith: { _, last in last })
    }
}

struct ResearchProfilePayload: Encodable {
    var name: String
    var title: String
    var description: String
    var pipeline: String
    var reasoning: ResearchProfileDetail.Reasoning
    var search: ResearchProfileDetail.Search
    var verification: ResearchProfileDetail.Verification
    var stop: ResearchProfileDetail.Stop
    var output: ResearchProfileDetail.Output
    var roles: [ResearchRole]
}

/// One row of `GET /api/research/profiles`.
struct ResearchProfileSummary: Decodable, Identifiable, Hashable {
    var name: String
    var title: String
    var description: String
    var builtin: Bool
    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, title, description, builtin
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? name
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        builtin = try c.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
    }
}

struct ResearchProfilesResponse: Decodable {
    var active: String
    var profiles: [ResearchProfileSummary]
}

struct DeleteProfileResponse: Decodable {
    var ok: Bool
    /// A built-in came back as its defaults rather than being removed.
    var reset: Bool?
}

enum SearchMode: String, CaseIterable, Identifiable {
    case hybrid
    case vector
    case keyword
    var id: String { rawValue }
}

extension String {
    var knodeInitials: String {
        let parts = split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." || $0 == "_" || $0 == "-" })
        if parts.count > 1 {
            return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased()
        }
        return String((parts.first ?? Substring("K")).prefix(2)).uppercased()
    }

    var knodeDate: String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: self) else { return self }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

extension Color {
    static let knodeCyan = Color(red: 0.36, green: 0.78, blue: 1.0)
    static let knodeViolet = Color(red: 0.71, green: 0.55, blue: 1.0)
    static let knodeGood = Color(red: 0.37, green: 0.82, blue: 0.59)
    static let knodeBad = Color(red: 1.0, green: 0.48, blue: 0.56)
}


/* ------------------------------ research studies ------------------------------ */

/// A study as the list shows it (GET /api/research/studies).
struct StudySummary: Decodable, Identifiable, Hashable {
    struct Step: Decodable, Hashable { var name: String; var status: String; var detail: String? }
    var id: String
    var status: String
    var stage: String
    var title: String
    var topic: String
    var pages: Int
    var createdAt: String
    var error: String?
    var steps: [Step]
    var pause: RunPause?
    var archivedAt: String?
}

/// A job waiting out a spent usage limit, a rate limit or a lost login (docs/design/22): it goes on by itself at `until`.
struct RunPause: Decodable, Hashable {
    /// quota, transient or setup.
    var kind: String
    /// The agent's own words.
    var reason: String
    var until: String
}

/// What removing a study took away (its jobs) and left in the knowledge base.
struct StudyRemoval: Decodable {
    var removed: [String]
    var kept: [String]
}

/// One study (GET /api/research/studies/:id): its brief, stages, pages, sources and report.
struct StudyDetail: Decodable {
    struct Job: Decodable { var id: String; var status: String; var agent: String?; var error: String?; var startedAt: String?; var finishedAt: String? }
    struct Clarification: Decodable, Hashable { var question: String; var options: [String]; var answer: String? }
    struct Question: Decodable, Hashable { var id: String; var text: String; var page: String }
    struct Page: Decodable, Hashable { var id: String; var title: String; var slug: String; var purpose: String; var sections: [String]; var questions: [String] }
    struct Report: Decodable { var title: String }
    struct Brief: Decodable {
        var title: String
        var slug: String
        var language: String
        var objective: String
        var restatement: String
        var clarifications: [Clarification]
        var questions: [Question]
        var pages: [Page]
        var report: Report
    }
    struct Runner: Decodable { var mode: String; var agent: String }
    struct Payload: Decodable {
        var topic: String
        var brief: Brief
        var stage: String
        var steps: [StudySummary.Step]
        var runner: Runner
    }
    struct PageState: Decodable, Identifiable, Hashable { var id: String; var title: String; var path: String; var status: String; var trust: String?; var error: String?; var pause: RunPause? }
    struct Capture: Decodable, Identifiable, Hashable {
        var path: String; var title: String?; var site: String; var kind: String; var published: String?; var url: String
        var id: String { path }
    }
    /// The files one Promote covers, by tier: `quarantined` is what it would make trusted.
    struct TierCounts: Decodable { var trusted: Int; var quarantined: Int; var unindexed: Int }
    struct Tiers: Decodable { var pages: TierCounts; var sources: TierCounts }
    var job: Job
    var payload: Payload
    var reportPath: String
    var reportExists: Bool
    var pages: [PageState]
    var captures: [Capture]
    var tiers: Tiers?
    var refining: String?
    var startProblem: String?
    /// What the study waits for, when it waits out a pause.
    var pause: RunPause?
    var archivedAt: String?

    var isLive: Bool { ["queued", "running", "validating", "waiting"].contains(job.status) || refining != nil }
}

/* ------------------------- explore and tasks (docs/design/20) ------------------------- */

// The JSON of these routes is camelCase already, so the snake_case decoder
// leaves every key as it came. Each decoder fills what is missing with an
// empty value rather than failing: one odd row must not cost the whole page.

/// `GET /api/search/explore`: the agents' retrieval asked to explain itself —
/// every passage with its rank in each channel that found it, each channel's
/// own count, and beside them the graph read: the entities the query names,
/// their neighbours, the relations between them and the claims about them.
struct ExploreResponse: Decodable {
    var query: String
    var mode: String
    /// What keyword and entity matching used: the words, and CJK bigrams.
    var terms: [String]
    var passages: [ExplorePassage]
    /// vector, keyword and graph, as the mode ran them; empty in multi-hop.
    var channels: [String: ExploreChannelStats]
    var entities: [ExploreEntity]
    var relations: [ExploreRelation]
    var claims: [ExploreClaim]
    var ms: Timing?
    /// Only the reads that failed: `passages`, `graph`.
    var errors: [String: String]

    struct Timing: Decodable, Hashable {
        var total: Int?
        var passages: Int?
        var graph: Int?
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = try c.decodeIfPresent(String.self, forKey: .query) ?? ""
        mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "hybrid"
        terms = try c.decodeIfPresent([String].self, forKey: .terms) ?? []
        passages = try c.decodeIfPresent([ExplorePassage].self, forKey: .passages) ?? []
        channels = try c.decodeIfPresent([String: ExploreChannelStats].self, forKey: .channels) ?? [:]
        entities = try c.decodeIfPresent([ExploreEntity].self, forKey: .entities) ?? []
        relations = try c.decodeIfPresent([ExploreRelation].self, forKey: .relations) ?? []
        claims = try c.decodeIfPresent([ExploreClaim].self, forKey: .claims) ?? []
        ms = try c.decodeIfPresent(Timing.self, forKey: .ms)
        errors = (try? c.decodeIfPresent([String: String].self, forKey: .errors)) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case query, mode, terms, passages, channels, entities, relations, claims, ms, errors
    }
}

struct ExploreChannelStats: Decodable, Hashable {
    var hits: Int
    var ms: Int?
    /// Why the channel could not answer — a spent embedding quota, say.
    var error: String?

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hits = try c.decodeIfPresent(Int.self, forKey: .hits) ?? 0
        ms = try c.decodeIfPresent(Int.self, forKey: .ms)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    private enum CodingKeys: String, CodingKey { case hits, ms, error }
}

struct ExplorePassage: Decodable, Identifiable, Hashable {
    var chunkId: String
    var documentId: String
    var path: String
    var title: String?
    var content: String
    var docDate: String?
    var score: Double
    /// Each channel's own measure: similarity, text rank or terms found, entities mentioned; `structural` in multi-hop.
    var signals: [String: Double]
    /// The passage's place in each channel that found it, from 1.
    var ranks: [String: Int]
    /// Multi-hop only: how the passage was reached.
    var trace: Trace?

    struct Trace: Decodable, Hashable {
        var route: String?
        var hop: Int?
        var bridgeEntities: [String]?
    }

    var id: String { chunkId }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chunkId = try c.decode(String.self, forKey: .chunkId)
        documentId = try c.decodeIfPresent(String.self, forKey: .documentId) ?? ""
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title)
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        docDate = try c.decodeIfPresent(String.self, forKey: .docDate)
        score = try c.decodeIfPresent(Double.self, forKey: .score) ?? 0
        signals = (try? c.decodeIfPresent([String: Double].self, forKey: .signals)) ?? [:]
        let rawRanks = (try? c.decodeIfPresent([String: Double].self, forKey: .ranks)) ?? [:]
        ranks = rawRanks.mapValues { Int($0.rounded()) }
        trace = try? c.decodeIfPresent(Trace.self, forKey: .trace)
    }

    private enum CodingKeys: String, CodingKey {
        case chunkId, documentId, path, title, content, docDate, score, signals, ranks, trace
    }
}

struct ExploreEntity: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var type: String
    var description: String
    var aliases: [String]
    var mentionCount: Int
    /// Live typed relations across the whole graph.
    var degree: Int
    var wikiPath: String?
    var score: Double
    /// Where the query named it; nil for a neighbour reached through a relation.
    var match: Match?

    struct Match: Decodable, Hashable {
        /// name, alias or description.
        var field: String
        var term: String
        /// The spelling or text that matched.
        var text: String
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "concept"
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        aliases = (try? c.decodeIfPresent([String].self, forKey: .aliases)) ?? []
        mentionCount = try c.decodeIfPresent(Int.self, forKey: .mentionCount) ?? 0
        degree = try c.decodeIfPresent(Int.self, forKey: .degree) ?? 0
        wikiPath = try c.decodeIfPresent(String.self, forKey: .wikiPath)
        score = try c.decodeIfPresent(Double.self, forKey: .score) ?? 0
        match = try? c.decodeIfPresent(Match.self, forKey: .match)
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, type, description, aliases, mentionCount, degree, wikiPath, score, match
    }
}

struct ExploreRelation: Decodable, Identifiable, Hashable {
    /// Entity ids.
    var source: String
    var target: String
    var type: String
    var description: String
    var weight: Double
    var validFrom: String?
    var validTo: String?

    var id: String { "\(source)-\(type)-\(target)" }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decode(String.self, forKey: .source)
        target = try c.decode(String.self, forKey: .target)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "related_to"
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        weight = try c.decodeIfPresent(Double.self, forKey: .weight) ?? 0
        validFrom = try c.decodeIfPresent(String.self, forKey: .validFrom)
        validTo = try c.decodeIfPresent(String.self, forKey: .validTo)
    }

    private enum CodingKeys: String, CodingKey {
        case source, target, type, description, weight, validFrom, validTo
    }
}

struct ExploreClaim: Decodable, Identifiable, Hashable {
    var id: String
    var subject: String
    var statement: String
    /// fact, disputed, superseded…
    var status: String
    var kind: String?
    var startDate: String?
    var path: String?
    var evidenceCount: Int?

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        statement = try c.decodeIfPresent(String.self, forKey: .statement) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "fact"
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        evidenceCount = try c.decodeIfPresent(Int.self, forKey: .evidenceCount)
    }

    private enum CodingKeys: String, CodingKey {
        case id, subject, statement, status, kind, startDate, path, evidenceCount
    }
}

/// `GET /api/search/suggest`: names and documents for the search field as
/// someone types — substring reads, no model.
struct SuggestResponse: Decodable, Equatable {
    struct Entity: Decodable, Hashable, Identifiable {
        var id: String
        var name: String
        var type: String
        var mentionCount: Int
        var wikiPath: String?
        /// The spelling that matched when the name did not.
        var alias: String?

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
            type = try c.decodeIfPresent(String.self, forKey: .type) ?? "concept"
            mentionCount = try c.decodeIfPresent(Int.self, forKey: .mentionCount) ?? 0
            wikiPath = try c.decodeIfPresent(String.self, forKey: .wikiPath)
            alias = try c.decodeIfPresent(String.self, forKey: .alias)
        }

        private enum CodingKeys: String, CodingKey { case id, name, type, mentionCount, wikiPath, alias }
    }

    struct Document: Decodable, Hashable, Identifiable {
        var path: String
        var title: String?
        var id: String { path }
    }

    var entities: [Entity]
    var documents: [Document]

    static let empty = SuggestResponse(entities: [], documents: [])

    init(entities: [Entity], documents: [Document]) {
        self.entities = entities
        self.documents = documents
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entities = (try? c.decodeIfPresent([Entity].self, forKey: .entities)) ?? []
        documents = (try? c.decodeIfPresent([Document].self, forKey: .documents)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case entities, documents }
}

/// `GET /api/tasks`: everything the workspace has under way or waiting, in
/// one read (src/server/tasks.ts). It only reports; starting and stopping
/// stays with the processing switch, the jobs' own routes and Dream's.
struct TasksSnapshot: Decodable {
    var at: String?
    /// False outside `serve`: no processing switch, no broker, no slots.
    var serving: Bool
    var processing: ProcessingState?
    var stages: [Stage]
    var inFlight: [InFlight]
    var workers: [Worker]
    var jobs: [Job]
    var activity: Activity
    var scheduled: [Scheduled]
    var folders: [Folder]
    var dream: DreamQueue
    var documentErrors: [DocumentError]

    struct Stage: Decodable, Identifiable {
        /// index, embed, extract, summarize, translate, review — in pipeline order.
        var id: String
        var enabled: Bool
        /// documents, chunks, translations or calls.
        var unit: String
        var waiting: Int
        var inFlight: Int
        var doneLastHour: Int?
        var callsLastHour: Int?
        var failed: Int
        /// What holds it up, in English: the service's own words.
        var note: String?

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
            unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? "documents"
            waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
            inFlight = try c.decodeIfPresent(Int.self, forKey: .inFlight) ?? 0
            doneLastHour = try c.decodeIfPresent(Int.self, forKey: .doneLastHour)
            callsLastHour = try c.decodeIfPresent(Int.self, forKey: .callsLastHour)
            failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
            note = try c.decodeIfPresent(String.self, forKey: .note)
        }

        private enum CodingKeys: String, CodingKey {
            case id, enabled, unit, waiting, inFlight, doneLastHour, callsLastHour, failed, note
        }
    }

    /// A lease out right now.
    struct InFlight: Decodable, Identifiable {
        var id: String
        /// extract, summarize, translate or judge.
        var kind: String
        /// The document, or for a judge call what it decides.
        var subject: String
        var detail: String?
        var worker: String
        var backend: String
        var remote: Bool
        var ageSeconds: Double
        var expiresInSeconds: Double

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "extract"
            subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
            detail = try c.decodeIfPresent(String.self, forKey: .detail)
            worker = try c.decodeIfPresent(String.self, forKey: .worker) ?? ""
            backend = try c.decodeIfPresent(String.self, forKey: .backend) ?? ""
            remote = try c.decodeIfPresent(Bool.self, forKey: .remote) ?? false
            ageSeconds = try c.decodeIfPresent(Double.self, forKey: .ageSeconds) ?? 0
            expiresInSeconds = try c.decodeIfPresent(Double.self, forKey: .expiresInSeconds) ?? 0
        }

        private enum CodingKeys: String, CodingKey {
            case id, kind, subject, detail, worker, backend, remote, ageSeconds, expiresInSeconds
        }
    }

    /// This machine's backends, one row each, and every remote worker the broker has seen.
    struct Worker: Decodable, Identifiable {
        var id: String
        var label: String
        var remote: Bool
        var kinds: [String]
        /// Local backends only: the parallel calls it may make.
        var slots: Int?
        var busy: Int
        var ok: Int
        var failed: Int
        var lastSeen: String?
        var online: Bool
        var pausedUntil: String?
        var pauseReason: String?
        var lastError: String?

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
            remote = try c.decodeIfPresent(Bool.self, forKey: .remote) ?? false
            kinds = (try? c.decodeIfPresent([String].self, forKey: .kinds)) ?? []
            slots = try c.decodeIfPresent(Int.self, forKey: .slots)
            busy = try c.decodeIfPresent(Int.self, forKey: .busy) ?? 0
            ok = try c.decodeIfPresent(Int.self, forKey: .ok) ?? 0
            failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
            lastSeen = try c.decodeIfPresent(String.self, forKey: .lastSeen)
            online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
            pausedUntil = try c.decodeIfPresent(String.self, forKey: .pausedUntil)
            pauseReason = try c.decodeIfPresent(String.self, forKey: .pauseReason)
            lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        }

        private enum CodingKeys: String, CodingKey {
            case id, label, remote, kinds, slots, busy, ok, failed, lastSeen, online, pausedUntil, pauseReason, lastError
        }
    }

    /// A research job, study or Ask turn running, or finished in the last day.
    struct Job: Decodable, Identifiable {
        var id: String
        /// study, research, init or ask.
        var kind: String
        var title: String
        var status: String
        var stage: String?
        var createdAt: String?
        var startedAt: String?
        var finishedAt: String?
        var error: String?
        var outputPath: String?
        /// A queued job waiting out a pause (a spent usage limit): until when, and the agent's words.
        var pausedUntil: String?
        var pauseReason: String?

        var isLive: Bool { ["queued", "running", "validating", "waiting"].contains(status) }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "research"
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
            stage = try c.decodeIfPresent(String.self, forKey: .stage)
            createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
            startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
            finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
            error = try c.decodeIfPresent(String.self, forKey: .error)
            outputPath = try c.decodeIfPresent(String.self, forKey: .outputPath)
            pausedUntil = try c.decodeIfPresent(String.self, forKey: .pausedUntil)
            pauseReason = try c.decodeIfPresent(String.self, forKey: .pauseReason)
        }

        private enum CodingKeys: String, CodingKey {
            case id, kind, title, status, stage, createdAt, startedAt, finishedAt, error, outputPath, pausedUntil, pauseReason
        }
    }

    /// Background work that is not leased model work (src/activity.ts).
    struct ActivityItem: Decodable, Identifiable {
        var id: String
        /// sync, ingest, upload, folder, feishu, conversations, codebase, traces, datasources, dream or tier2.
        var kind: String
        /// In English, the service's own words: "Index new and changed files".
        var label: String
        var startedAt: String?
        var finishedAt: String?
        var ok: Bool?
        var detail: String?
        /// While it runs, where it is: "2 of 5 · fetching Meeting notes".
        var progress: String?
    }

    struct Activity: Decodable {
        var running: [ActivityItem]
        var recent: [ActivityItem]

        init(running: [ActivityItem] = [], recent: [ActivityItem] = []) {
            self.running = running
            self.recent = recent
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            running = (try? c.decodeIfPresent([ActivityItem].self, forKey: .running)) ?? []
            recent = (try? c.decodeIfPresent([ActivityItem].self, forKey: .recent)) ?? []
        }

        private enum CodingKeys: String, CodingKey { case running, recent }
    }

    /// What runs on a clock: dream, tier2, traces, datasources.
    struct Scheduled: Decodable, Identifiable {
        var id: String
        /// "03:00" for a daily run.
        var at: String?
        var everyMinutes: Int?
        /// The next start, when the clock says.
        var next: String?
        /// When it last ran, for a task that keeps that across restarts (the Feishu check, followed repositories).
        var last: String?
        var enabled: Bool
        var running: Bool

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            at = try c.decodeIfPresent(String.self, forKey: .at)
            everyMinutes = try c.decodeIfPresent(Int.self, forKey: .everyMinutes)
            next = try c.decodeIfPresent(String.self, forKey: .next)
            last = try c.decodeIfPresent(String.self, forKey: .last)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
            running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        }

        private enum CodingKeys: String, CodingKey { case id, at, everyMinutes, next, last, enabled, running }
    }

    /// A linked folder and how its mirror is doing.
    struct Folder: Decodable, Identifiable {
        struct Change: Decodable {
            var copied: Int?
            var removed: Int?
            var at: String?
        }

        var dest: String
        var source: String
        var watching: Bool
        var lastSyncAt: String?
        var lastError: String?
        var lastChange: Change?

        var id: String { dest }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            dest = try c.decode(String.self, forKey: .dest)
            source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
            watching = try c.decodeIfPresent(Bool.self, forKey: .watching) ?? false
            lastSyncAt = try c.decodeIfPresent(String.self, forKey: .lastSyncAt)
            lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
            lastChange = try? c.decodeIfPresent(Change.self, forKey: .lastChange)
        }

        private enum CodingKeys: String, CodingKey { case dest, source, watching, lastSyncAt, lastError, lastChange }
    }

    struct DreamQueue: Decodable {
        var pendingSuggestions: Int
        var lastSuggestionAt: String?
        var lookbackDays: Int?

        init(pendingSuggestions: Int = 0, lastSuggestionAt: String? = nil, lookbackDays: Int? = nil) {
            self.pendingSuggestions = pendingSuggestions
            self.lastSuggestionAt = lastSuggestionAt
            self.lookbackDays = lookbackDays
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pendingSuggestions = try c.decodeIfPresent(Int.self, forKey: .pendingSuggestions) ?? 0
            lastSuggestionAt = try c.decodeIfPresent(String.self, forKey: .lastSuggestionAt)
            lookbackDays = try c.decodeIfPresent(Int.self, forKey: .lookbackDays)
        }

        private enum CodingKeys: String, CodingKey { case pendingSuggestions, lastSuggestionAt, lookbackDays }
    }

    struct DocumentError: Decodable, Identifiable {
        var path: String
        var error: String?
        var id: String { path }
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decodeIfPresent(String.self, forKey: .at)
        serving = try c.decodeIfPresent(Bool.self, forKey: .serving) ?? false
        processing = try? c.decodeIfPresent(ProcessingState.self, forKey: .processing)
        stages = (try? c.decodeIfPresent([Stage].self, forKey: .stages)) ?? []
        inFlight = (try? c.decodeIfPresent([InFlight].self, forKey: .inFlight)) ?? []
        workers = (try? c.decodeIfPresent([Worker].self, forKey: .workers)) ?? []
        jobs = (try? c.decodeIfPresent([Job].self, forKey: .jobs)) ?? []
        activity = (try? c.decodeIfPresent(Activity.self, forKey: .activity)) ?? Activity()
        scheduled = (try? c.decodeIfPresent([Scheduled].self, forKey: .scheduled)) ?? []
        folders = (try? c.decodeIfPresent([Folder].self, forKey: .folders)) ?? []
        dream = (try? c.decodeIfPresent(DreamQueue.self, forKey: .dream)) ?? DreamQueue()
        documentErrors = (try? c.decodeIfPresent([DocumentError].self, forKey: .documentErrors)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case at, serving, processing, stages, inFlight, workers, jobs, activity, scheduled, folders, dream, documentErrors
    }
}

/// `POST /api/folders/preview`: what linking or importing a folder would
/// carry, before anything is written.
struct FolderImportPlan: Decodable, Identifiable {
    struct Link: Decodable, Hashable {
        var source: String
        var dest: String
    }

    /// The folder on the service's machine, as the service resolved it.
    var source: String
    var dest: String
    var files: Int
    var bytes: Int
    /// Files of types knode-os cannot index, left behind.
    var skippedByType: Int
    /// Files copied but too large to index.
    var tooLarge: Int
    /// The destination exists already: it becomes the mirror, and files only it has go.
    var exists: Bool
    /// Set when the destination is already a linked folder's mirror.
    var linked: Link?
    var sample: [String]

    var id: String { "\(source)→\(dest)" }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
        dest = try c.decodeIfPresent(String.self, forKey: .dest) ?? ""
        files = try c.decodeIfPresent(Int.self, forKey: .files) ?? 0
        bytes = try c.decodeIfPresent(Int.self, forKey: .bytes) ?? 0
        skippedByType = try c.decodeIfPresent(Int.self, forKey: .skippedByType) ?? 0
        tooLarge = try c.decodeIfPresent(Int.self, forKey: .tooLarge) ?? 0
        exists = try c.decodeIfPresent(Bool.self, forKey: .exists) ?? false
        linked = try? c.decodeIfPresent(Link.self, forKey: .linked)
        sample = (try? c.decodeIfPresent([String].self, forKey: .sample)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case source, dest, files, bytes, skippedByType, tooLarge, exists, linked, sample }
}

/// `POST /api/folders/import`: what the copy did. Indexing usually goes on
/// in the background after the answer (`indexing`), else `sync` says how it went.
struct FolderImportResult: Decodable {
    struct Sync: Decodable {
        var indexed: Int?
        var skipped: Int?
    }

    var dest: String
    var copied: [String]
    var sync: Sync?
    var indexing: Bool

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dest = try c.decodeIfPresent(String.self, forKey: .dest) ?? ""
        copied = (try? c.decodeIfPresent([String].self, forKey: .copied)) ?? []
        sync = try? c.decodeIfPresent(Sync.self, forKey: .sync)
        indexing = try c.decodeIfPresent(Bool.self, forKey: .indexing) ?? false
    }

    private enum CodingKeys: String, CodingKey { case dest, copied, sync, indexing }
}

/// `POST /api/conversations/sync` without a copy named: a check of every
/// followed conversation starts in the background (`started`), unless one is
/// under way already.
struct ConversationCheck: Decodable {
    var started: Bool
    var links: Int

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        started = try c.decodeIfPresent(Bool.self, forKey: .started) ?? false
        links = try c.decodeIfPresent(Int.self, forKey: .links) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case started, links }
}

/// `POST /api/feishu/sync`: a check of every link starts in the background
/// (`started`, or a check was under way already); one of a single mirror
/// answers with what it found.
struct FeishuCheck: Decodable {
    struct Pages: Decodable {
        var total: Int?
        var documents: Int?
        var fetched: Int?
        var moved: Int?
        var removed: Int?
    }

    struct Result: Decodable {
        var dest: String
        var title: String?
        var fetched: Bool
        var written: Int
        var removed: Int
        var modifiedAt: String?
        var pages: Pages?
        var error: String?

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            dest = try c.decodeIfPresent(String.self, forKey: .dest) ?? ""
            title = try c.decodeIfPresent(String.self, forKey: .title)
            fetched = try c.decodeIfPresent(Bool.self, forKey: .fetched) ?? false
            written = try c.decodeIfPresent(Int.self, forKey: .written) ?? 0
            removed = try c.decodeIfPresent(Int.self, forKey: .removed) ?? 0
            modifiedAt = try c.decodeIfPresent(String.self, forKey: .modifiedAt)
            pages = try? c.decodeIfPresent(Pages.self, forKey: .pages)
            error = try c.decodeIfPresent(String.self, forKey: .error)
        }

        private enum CodingKeys: String, CodingKey { case dest, title, fetched, written, removed, modifiedAt, pages, error }
    }

    var started: Bool
    var links: Int?
    var results: [Result]

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        started = try c.decodeIfPresent(Bool.self, forKey: .started) ?? false
        links = try c.decodeIfPresent(Int.self, forKey: .links)
        results = (try? c.decodeIfPresent([Result].self, forKey: .results)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case started, links, results }
}

/// `GET /api/codebases`: the code repositories kept in the workspace
/// (docs/design/25), whether a fetch is running, and the `codebase`
/// activity — what is fetching now and how the last few ended.
struct CodebaseListing: Decodable {
    var codebases: [CodebaseEntry]
    var running: Bool
    var activity: [TasksSnapshot.ActivityItem]
    var recent: [TasksSnapshot.ActivityItem]

    init(codebases: [CodebaseEntry] = [], running: Bool = false, activity: [TasksSnapshot.ActivityItem] = [], recent: [TasksSnapshot.ActivityItem] = []) {
        self.codebases = codebases
        self.running = running
        self.activity = activity
        self.recent = recent
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        codebases = (try? c.decodeIfPresent([CodebaseEntry].self, forKey: .codebases)) ?? []
        running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        activity = (try? c.decodeIfPresent([TasksSnapshot.ActivityItem].self, forKey: .activity)) ?? []
        recent = (try? c.decodeIfPresent([TasksSnapshot.ActivityItem].self, forKey: .recent)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case codebases, running, activity, recent }
}

/// One repository kept under raw/codebase/<name>/ at one commit.
struct CodebaseEntry: Decodable, Identifiable, Hashable {
    var name: String
    /// What git fetches from, and the repository's web page when it has one.
    var url: String
    var web: String?
    /// Branch, tag or commit tracked; nil = the remote's default branch.
    var ref: String?
    var include: [String]
    var exclude: [String]
    /// Fetched again once a day by the service.
    var follow: Bool
    /// Its documentation is copied to raw/docs/codebase/<name>/.
    var docs: Bool
    var commit: String?
    var committedAt: String?
    var checkedAt: String?
    /// raw/codebase/<name> and the card, raw/docs/codebase/<name>.md.
    var dir: String
    var card: String
    var files: Int
    var bytes: Int

    var id: String { name }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        url = try c.decodeIfPresent(String.self, forKey: .url) ?? ""
        web = try? c.decodeIfPresent(String.self, forKey: .web)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        include = (try? c.decodeIfPresent([String].self, forKey: .include)) ?? []
        exclude = (try? c.decodeIfPresent([String].self, forKey: .exclude)) ?? []
        follow = try c.decodeIfPresent(Bool.self, forKey: .follow) ?? false
        docs = try c.decodeIfPresent(Bool.self, forKey: .docs) ?? true
        commit = try c.decodeIfPresent(String.self, forKey: .commit)
        committedAt = try c.decodeIfPresent(String.self, forKey: .committedAt)
        checkedAt = try c.decodeIfPresent(String.self, forKey: .checkedAt)
        dir = try c.decodeIfPresent(String.self, forKey: .dir) ?? "raw/codebase/\(name)"
        card = try c.decodeIfPresent(String.self, forKey: .card) ?? "raw/docs/codebase/\(name).md"
        files = try c.decodeIfPresent(Int.self, forKey: .files) ?? 0
        bytes = try c.decodeIfPresent(Int.self, forKey: .bytes) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case name, url, web, ref, include, exclude, follow, docs, commit, committedAt, checkedAt, dir, card, files, bytes
    }
}

/// What adding a repository sends (`POST /api/codebases/add`).
struct CodebaseDraft: Encodable {
    var repository: String
    var name: String?
    var ref: String?
    var include: [String]
    var exclude: [String]
    var follow: Bool
    var docs: Bool
}

/// What editing one sends (`PATCH /api/codebases`); an empty ref goes back to the default branch.
struct CodebasePatch: Encodable {
    var name: String
    var ref: String
    var include: [String]
    var exclude: [String]
    var follow: Bool
    var docs: Bool
}

/// `POST /api/codebases/add` or `/update` without waiting: the fetch started in the background
/// (an update also says how many repositories it fetches, and whether it waits behind a fetch under way).
struct CodebaseStarted: Decodable {
    var started: Bool
    var repositories: Int
    var queued: Bool

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        started = try c.decodeIfPresent(Bool.self, forKey: .started) ?? false
        repositories = try c.decodeIfPresent(Int.self, forKey: .repositories) ?? 0
        queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
    }

    private enum CodingKeys: String, CodingKey { case started, repositories, queued }
}

/// `DELETE /api/codebases`: whether the files went with the entry.
struct CodebaseRemoval: Decodable {
    var name: String
    var removedFiles: Bool

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        removedFiles = try c.decodeIfPresent(Bool.self, forKey: .removedFiles) ?? false
    }

    private enum CodingKeys: String, CodingKey { case name, removedFiles }
}

/// Times the service sends (`toISOString`, with or without milliseconds).
enum ServiceTime {
    static func date(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// "45 s", "3 min", "2 h 5 min", "3 days".
    @MainActor static func span(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        if s < 60 { return L("%@ s", String(s)) }
        if s < 3600 {
            let m = s / 60
            return s < 600 && s % 60 > 0 ? L("%@ min %@ s", String(m), String(s % 60)) : L("%@ min", String(m))
        }
        let h = s / 3600
        let m = (s % 3600) / 60
        if h >= 48 { return L("%@ days", String(Int((Double(h) / 24).rounded()))) }
        return m > 0 ? L("%@ h %@ min", String(h), String(m)) : L("%@ h", String(h))
    }

    /// "5 min ago", or "never" for no time at all.
    @MainActor static func ago(_ iso: String?, now: Date = Date()) -> String {
        guard let date = date(iso) else { return L("never") }
        return L("%@ ago", span(now.timeIntervalSince(date)))
    }

    /// "in 4 h".
    @MainActor static func until(_ iso: String?, now: Date = Date()) -> String? {
        guard let date = date(iso) else { return nil }
        return L("in %@", span(date.timeIntervalSince(now)))
    }

    /// "14:02".
    static func clock(_ iso: String?) -> String? {
        date(iso)?.formatted(date: .omitted, time: .shortened)
    }
}
