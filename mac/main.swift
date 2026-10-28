// Flux for Mac: a native window around the Flux inbox, plus macOS notifications for new
// important mail. The Flux server runs on this Mac (bundled, started with Node) or on your
// own server through an SSH tunnel; either way it answers at localhost:3030. The app
// listens to the server's live event stream, so notifications arrive while the window is closed.
import AppKit
import ServiceManagement
import UserNotifications
import WebKit

let base = URL(string: "http://localhost:3030")!

/// Asks the server for something tiny to see whether it's reachable (tunnel up, server up).
func serverReachable() async -> Bool {
    var request = URLRequest(url: base.appendingPathComponent("api/push/key"))
    request.timeoutInterval = 3
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
}

// MARK: - Server

/// Where Flux's server runs. By default, on this Mac: the app starts the bundled server
/// with Node. Optionally on your own server, reached through an SSH tunnel. The choice is
/// kept in UserDefaults; a host set in config.env at build time is the default.
enum ServerMode: Equatable {
    case local
    case remote(host: String, key: String)

    static var current: ServerMode {
        let defaults = UserDefaults.standard
        let host = defaults.string(forKey: "remoteHost") ?? FluxConfig.host
        guard !host.isEmpty else { return .local }
        return .remote(host: host, key: defaults.string(forKey: "remoteKey") ?? FluxConfig.sshKey)
    }
}

/// Keeps the server reachable at localhost:3030: starts it (local) or the tunnel (remote)
/// and restarts it if it dies. If something already answers there (a tunnel from
/// flux-open.sh, or `npm start`), it leaves that alone.
final class Server {
    private var process: Process?
    private var timer: Timer?
    private var warnedNoNode = false

    static var supportDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Flux")
    }

    func start() {
        check()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.check() }
    }

    func stop() {
        timer?.invalidate()
        process?.terminate()
    }

    /// After switching between this Mac and a remote server.
    func restart() {
        process?.terminate()
        process = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.check() }
    }

    private func check() {
        Task { @MainActor in
            if self.process?.isRunning == true { return }
            if await serverReachable() { return }
            self.launch()
        }
    }

    private func launch() {
        switch ServerMode.current {
        case .remote(let host, let key): launchTunnel(host: host, key: NSString(string: key).expandingTildeInPath)
        case .local: launchLocal()
        }
    }

    private func launchTunnel(host: String, key: String) {
        let ssh = Process()
        ssh.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        ssh.arguments = [
            "-i", key, "-N",
            "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes",
            "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
            "-L", "3030:127.0.0.1:3030", host,
        ]
        ssh.standardOutput = FileHandle.nullDevice
        ssh.standardError = FileHandle.nullDevice
        try? ssh.run()
        process = ssh
    }

    /// Runs the server bundled in Flux.app/Contents/Resources/server with the Mac's Node.
    /// Its data (push keys) and the user's rules.json live in Application Support/Flux.
    private func launchLocal() {
        guard let node = Server.findNode() else {
            if !warnedNoNode {
                warnedNoNode = true
                let alert = NSAlert()
                alert.messageText = "Flux needs Node.js"
                alert.informativeText = "Install Node.js 20.11 or newer (for example: brew install node), then reopen Flux."
                alert.runModal()
            }
            return
        }
        let support = Server.supportDir
        try? FileManager.default.createDirectory(at: support.appendingPathComponent("data"), withIntermediateDirectories: true)
        let serverDir = Bundle.main.resourceURL!.appendingPathComponent("server")
        let log = support.appendingPathComponent("server.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)

        let server = Process()
        server.executableURL = node
        server.arguments = [serverDir.appendingPathComponent("server.js").path]
        server.currentDirectoryURL = serverDir
        var env = ProcessInfo.processInfo.environment
        env["FLUX_DATA_DIR"] = support.appendingPathComponent("data").path
        env["FLUX_RULES"] = support.appendingPathComponent("rules.json").path
        server.environment = env
        if let handle = try? FileHandle(forWritingTo: log) {
            server.standardOutput = handle
            server.standardError = handle
        }
        try? server.run()
        process = server
    }

    /// Node from Homebrew, the official installer, or the user's login shell PATH (nvm etc.).
    static func findNode() -> URL? {
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        shell.standardOutput = pipe
        shell.standardError = FileHandle.nullDevice
        guard (try? shell.run()) != nil else { return nil }
        shell.waitUntilExit()
        let path = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.isEmpty ? nil : URL(fileURLWithPath: path)
    }
}

// MARK: - Live feed and notifications

/// Reads the server's event stream (/api/events) and turns each worthwhile new email into a
/// macOS notification. Reconnects whenever the stream drops (sleep, network change).
final class LiveFeed {
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90 // the server pings every 25 s
        config.timeoutIntervalForResource = .infinity
        return URLSession(configuration: config)
    }()

    func start() {
        Task.detached { await self.run() }
    }

    private func run() async {
        while true {
            do {
                let (bytes, _) = try await session.bytes(from: base.appendingPathComponent("api/events"))
                for try await line in bytes.lines where line.hasPrefix("data: ") {
                    handle(Data(line.dropFirst(6).utf8))
                }
            } catch {}
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    private func handle(_ data: Data) {
        guard let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = event["message"] as? [String: Any],
              let note = event["note"] as? [String: Any],
              let title = note["title"] as? String else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = note["body"] as? String ?? ""
        content.sound = .default
        content.userInfo = [
            "account": message["account"] as? String ?? "",
            "folder": message["folder"] as? String ?? "INBOX",
            "uid": message["uid"] as? Int ?? 0,
            "code": note["code"] as? String ?? "",
        ]
        if note["kind"] as? String == "otp", note["code"] is String {
            content.categoryIdentifier = "OTP"
            content.interruptionLevel = .timeSensitive
        }
        let id = "\(content.userInfo["account"]!):\(content.userInfo["folder"]!):\(content.userInfo["uid"]!)"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        Task { @MainActor in (NSApp.delegate as? AppDelegate)?.refreshBadge() }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let server = Server()
    private let feed = LiveFeed()
    private var loginItem: NSMenuItem!
    private var serverMenu: NSMenu!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        setUpNotifications()
        server.start()
        feed.start()
        Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refreshBadge() }
        refreshBadge()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    // MARK: Window

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        // Lets the page know it's inside the app (it hides the browser-push bell).
        config.userContentController.addUserScript(WKUserScript(
            source: "window.FLUX_NATIVE = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Flux"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 420, height: 520)
        window.backgroundColor = NSColor(red: 0xF5 / 255, green: 0xF4 / 255, blue: 0xEF / 255, alpha: 1)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("FluxMain")
        if !window.setFrameUsingName("FluxMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        load()
    }

    private func load() {
        webView.load(URLRequest(url: base))
    }

    func showWindow(openHash: String? = nil) {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let hash = openHash {
            webView.evaluateJavaScript("location.hash = \(String(reflecting: hash))")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refreshBadge()
    }

    // Server not reachable yet (tunnel still opening): try again shortly.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.load() }
    }

    // Links (from emails) open in the default browser, never inside Flux.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.targetFrame?.isMainFrame == true, url.host != base.host {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: Dock badge: unread Focused mail

    func refreshBadge() {
        Task { @MainActor in
            guard let (data, _) = try? await URLSession.shared.data(from: base.appendingPathComponent("api/inbox")),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let messages = json["messages"] as? [[String: Any]] else { return }
            let unread = messages.filter { ($0["focused"] as? Bool) == true && ($0["seen"] as? Bool) == false }.count
            NSApp.dockTile.badgeLabel = unread > 0 ? String(unread) : nil
        }
    }

    // MARK: Notifications

    private func setUpNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let copy = UNNotificationAction(identifier: "COPY", title: "Copy code")
        center.setNotificationCategories([UNNotificationCategory(identifier: "OTP", actions: [copy], intentIdentifiers: [])])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    // Show banners even while Flux is in front.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // OTP: copy the code. Anything else: open that email in Flux.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let code = info["code"] as? String ?? ""
        DispatchQueue.main.async {
            if !code.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
            }
            if response.actionIdentifier != "COPY",
               let account = info["account"] as? String, let folder = info["folder"] as? String, let uid = info["uid"] as? Int {
                let encoded = folder.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? folder
                self.showWindow(openHash: "#open=\(account)/\(encoded)/\(uid)")
            }
            completionHandler()
        }
    }

    // MARK: Menu

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Flux", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        loginItem = appMenu.addItem(withTitle: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Flux", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Flux", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Edit menu: without it, copy/paste shortcuts don't reach the web view.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let serverItem = NSMenuItem()
        serverMenu = NSMenu(title: "Server")
        serverMenu.addItem(withTitle: "This Mac", action: #selector(useThisMac), keyEquivalent: "").target = self
        serverMenu.addItem(withTitle: "Remote Server…", action: #selector(useRemote), keyEquivalent: "").target = self
        serverMenu.addItem(.separator())
        serverMenu.addItem(withTitle: "Open Data Folder", action: #selector(openSupport), keyEquivalent: "").target = self
        serverItem.submenu = serverMenu
        main.addItem(serverItem)
        refreshServerMenu()

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Inbox", action: #selector(showInbox), keyEquivalent: "0").target = self
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc private func reload() { load() }

    // MARK: Server choice

    private func refreshServerMenu() {
        let local = ServerMode.current == .local
        serverMenu.item(at: 0)?.state = local ? .on : .off
        serverMenu.item(at: 1)?.state = local ? .off : .on
    }

    private func switchServer() {
        refreshServerMenu()
        server.restart()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.load() }
    }

    @objc private func useThisMac() {
        UserDefaults.standard.set("", forKey: "remoteHost")
        switchServer()
    }

    /// Asks for user@host and the SSH key; the server there must run Flux on 127.0.0.1:3030.
    @objc private func useRemote() {
        let alert = NSAlert()
        alert.messageText = "Use your own server"
        alert.informativeText = "Flux connects over SSH and forwards the server's 127.0.0.1:3030 to this Mac. The server must already run Flux (see the README)."
        let host = NSTextField(frame: NSRect(x: 0, y: 30, width: 300, height: 24))
        host.placeholderString = "user@your-server"
        let key = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        key.placeholderString = "~/.ssh/id_ed25519"
        if case .remote(let h, let k) = ServerMode.current { host.stringValue = h; key.stringValue = k }
        let fields = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 54))
        fields.addSubview(host)
        fields.addSubview(key)
        alert.accessoryView = fields
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let hostValue = host.stringValue.trimmingCharacters(in: .whitespaces)
        guard !hostValue.isEmpty else { return }
        UserDefaults.standard.set(hostValue, forKey: "remoteHost")
        UserDefaults.standard.set(key.stringValue.isEmpty ? "~/.ssh/id_ed25519" : key.stringValue, forKey: "remoteKey")
        switchServer()
    }

    @objc private func openSupport() {
        try? FileManager.default.createDirectory(at: Server.supportDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Server.supportDir)
    }
    @objc private func showInbox() { showWindow() }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            NSAlert(error: error).runModal()
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
