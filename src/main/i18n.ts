import { app } from "electron";
import Store from "electron-store";

export type MainLanguage = "en" | "vi";

type MainTextKey =
	| "dialog.openProject"
	| "menu.about"
	| "menu.addToDictionary"
	| "menu.closeTab"
	| "menu.closeWindow"
	| "menu.commandCenter"
	| "menu.capabilities"
	| "menu.importSession"
	| "menu.branchPicker"
	| "menu.sessionTree"
	| "menu.modelPicker"
	| "menu.usage"
	| "menu.workspaceChanges"
	| "menu.restartCore"
	| "menu.contextReport"
	| "menu.debugConsole"
	| "menu.documentation"
	| "menu.edit"
	| "menu.exportHtml"
	| "menu.file"
	| "menu.handoff"
	| "menu.help"
	| "menu.hotkeys"
	| "menu.jobs"
	| "menu.agentHub"
	| "menu.extensions"
	| "menu.inventory"
	| "menu.modes"
	| "menu.modelRoles"
	| "menu.newChatTab"
	| "menu.newSession"
	| "menu.newTab"
	| "menu.newWindow"
	| "menu.openProject"
	| "menu.prCenter"
	| "menu.providers"
	| "menu.session"
	| "menu.sessionInfo"
	| "menu.shareSession"
	| "menu.settings"
	| "menu.stats"
	| "menu.togglePanel"
	| "menu.toggleSidebar"
	| "menu.tools"
	| "menu.view"
	| "menu.window"
	| "menu.workspaceDirs"
	| "quit.keepWorking"
	| "quit.quitAnyway"
	| "quit.workingBody"
	| "quit.workingTitle"
	| "restart.body"
	| "restart.later"
	| "restart.now"
	| "restart.title"
	| "updates.downloadFailed"
	| "updates.hashMismatch"
	| "updates.installFailed"
	| "updates.installerMissing"
	| "updates.noResult"
	| "updates.openInstallerFailed"
	| "updates.unsupportedArchitecture";

const TEXT: Record<MainTextKey, Record<MainLanguage, string>> = {
	"dialog.openProject": { en: "Open project", vi: "Mở dự án" },
	"menu.about": { en: "About Sai ATLAS", vi: "Giới thiệu về Sai ATLAS" },
	"menu.addToDictionary": { en: "Add to dictionary", vi: "Thêm vào từ điển" },
	"menu.closeTab": { en: "Close Tab", vi: "Đóng thẻ" },
	"menu.closeWindow": { en: "Close Window", vi: "Đóng cửa sổ" },
	"menu.commandCenter": { en: "Command Center", vi: "Trung tâm lệnh" },
	"menu.capabilities": { en: "Capabilities", vi: "Khả năng" },
	"menu.importSession": { en: "Import Session", vi: "Nhập phiên" },
	"menu.branchPicker": { en: "Branch from Message", vi: "Tạo nhánh từ tin nhắn" },
	"menu.sessionTree": { en: "Session Tree", vi: "Cây phiên" },
	"menu.modelPicker": { en: "Select Model", vi: "Chọn mô hình" },
	"menu.usage": { en: "Usage", vi: "Mức sử dụng" },
	"menu.workspaceChanges": { en: "Git Changes", vi: "Thay đổi Git" },
	"menu.restartCore": { en: "Restart OMP Core", vi: "Khởi động lại OMP Core" },
	"menu.contextReport": { en: "Context Report", vi: "Báo cáo ngữ cảnh" },
	"menu.debugConsole": { en: "Debug Console", vi: "Bảng điều khiển gỡ lỗi" },
	"menu.documentation": { en: "Documentation", vi: "Tài liệu" },
	"menu.edit": { en: "Edit", vi: "Chỉnh sửa" },
	"menu.exportHtml": { en: "Export HTML", vi: "Xuất HTML" },
	"menu.file": { en: "File", vi: "Tệp" },
	"menu.handoff": { en: "Handoff", vi: "Bàn giao (Handoff)" },
	"menu.help": { en: "Help", vi: "Trợ giúp" },
	"menu.hotkeys": { en: "Keyboard Shortcuts", vi: "Phím tắt bàn phím" },
	"menu.jobs": { en: "Jobs", vi: "Tác vụ" },
	"menu.agentHub": { en: "Agent Hub", vi: "Trung tâm Agent" },
	"menu.extensions": { en: "Extensions", vi: "Tiện ích mở rộng" },
	"menu.inventory": { en: "Plugins & Resources", vi: "Plugin & Tài nguyên" },
	"menu.modes": { en: "Modes", vi: "Chế độ" },
	"menu.modelRoles": { en: "Model Roles", vi: "Vai trò mô hình" },
	"menu.newChatTab": { en: "New Chat Tab", vi: "Thẻ trò chuyện mới" },
	"menu.newSession": { en: "New Session", vi: "Phiên mới" },
	"menu.newTab": { en: "New Tab", vi: "Thẻ mới" },
	"menu.newWindow": { en: "New Window", vi: "Cửa sổ mới" },
	"menu.openProject": { en: "Open Project…", vi: "Mở dự án…" },
	"menu.prCenter": { en: "PR Center", vi: "Trung tâm PR" },
	"menu.providers": { en: "Providers & Login", vi: "Nhà cung cấp & Đăng nhập" },
	"menu.session": { en: "Session", vi: "Phiên" },
	"menu.sessionInfo": { en: "Session Info", vi: "Thông tin phiên" },
	"menu.shareSession": { en: "Share Session", vi: "Chia sẻ phiên" },
	"menu.settings": { en: "Settings…", vi: "Cài đặt…" },
	"menu.stats": { en: "Session Stats", vi: "Thống kê phiên" },
	"menu.togglePanel": { en: "Toggle Panel", vi: "Bật/Tắt bảng điều khiển" },
	"menu.toggleSidebar": { en: "Toggle Sidebar", vi: "Bật/Tắt thanh bên" },
	"menu.tools": { en: "Tools", vi: "Công cụ" },
	"menu.view": { en: "View", vi: "Xem" },
	"menu.window": { en: "Window", vi: "Cửa sổ" },
	"menu.workspaceDirs": { en: "Workspace Directories", vi: "Thư mục không gian làm việc" },
	"quit.keepWorking": { en: "Keep working", vi: "Tiếp tục làm việc" },
	"quit.quitAnyway": { en: "Quit anyway", vi: "Vẫn thoát" },
	"quit.workingBody": {
		en: "{working} of {total} sessions are still working in {windows} window(s). Quitting stops them and their agents.",
		vi: "{working} trên {total} phiên vẫn đang hoạt động trong {windows} cửa sổ. Thoát sẽ dừng các phiên này và các agent của chúng.",
	},
	"quit.workingTitle": { en: "Sessions are still running", vi: "Các phiên vẫn đang chạy" },
	"restart.body": {
		en: "Sai ATLAS's installed files were replaced while it was running, so this window can no longer load them reliably. {working} of {total} sessions are still working.",
		vi: "Các tệp cài đặt của Sai ATLAS đã bị thay thế khi đang chạy, do đó cửa sổ này không thể tải chúng ổn định nữa. {working} trên {total} phiên vẫn đang hoạt động.",
	},
	"restart.later": { en: "Later", vi: "Để sau" },
	"restart.now": { en: "Restart now", vi: "Khởi động lại ngay" },
	"restart.title": { en: "Restart to finish updating", vi: "Khởi động lại để hoàn tất cập nhật" },
	"updates.downloadFailed": {
		en: "The installer download failed.",
		vi: "Tải xuống trình cài đặt thất bại.",
	},
	"updates.hashMismatch": {
		en: "The downloaded installer failed SHA-512 verification and was removed.",
		vi: "Trình cài đặt đã tải xuống không vượt qua xác minh SHA-512 và đã bị xóa.",
	},
	"updates.installFailed": {
		en: "The update could not be installed.",
		vi: "Không thể cài đặt bản cập nhật.",
	},
	"updates.installerMissing": {
		en: "This release does not include the required installer for this Mac.",
		vi: "Bản phát hành này không bao gồm trình cài đặt cần thiết cho máy Mac này.",
	},
	"updates.noResult": {
		en: "Update check completed without a result.",
		vi: "Kiểm tra cập nhật hoàn tất nhưng không có kết quả.",
	},
	"updates.openInstallerFailed": {
		en: "The installer was downloaded, but macOS could not open it.",
		vi: "Trình cài đặt đã được tải xuống, nhưng macOS không thể mở tệp.",
	},
	"updates.unsupportedArchitecture": {
		en: "This Mac architecture does not have a supported installer.",
		vi: "Kiến trúc máy Mac này không có trình cài đặt được hỗ trợ.",
	},
};

const prefs = new Store<{ language?: MainLanguage }>({ name: "prefs" });

export function getMainLanguage(): MainLanguage {
	const stored = prefs.get("language");
	if (stored === "en" || stored === "vi") return stored;
	return app.getLocale().toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function mainT(
	key: MainTextKey,
	language = getMainLanguage(),
	params?: Record<string, string | number>,
): string {
	if (!params) return TEXT[key][language];
	return TEXT[key][language].replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}
