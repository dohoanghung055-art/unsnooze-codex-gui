# Unsnooze — Henry's Codex GUI mod

**Bản mod này chủ yếu phục vụ Codex GUI / Codex Desktop trên Windows.** Đây là bản fork cá nhân của Henry, được chỉnh sửa cùng Codex; không phải bản phát hành chính thức của Unsnooze hay OpenAI.

Unsnooze gốc do **Saaransh Menon** phát triển: [saaranshM/unsnooze](https://github.com/saaranshM/unsnooze). Bản chia sẻ dựa trên upstream **1.20.1**, commit `fe3c34f97cf4cb4f86e76734ba44b94b802b4de2`. Giữ nguyên giấy phép MIT và thông tin tác giả gốc trong `LICENSE`.

Phiên bản chia sẻ: **1.20.1-henry-codex-gui.20261028**.

## Cài trực tiếp từ GitHub

[Tải bản phát hành và gói ZIP](https://github.com/dohoanghung055-art/unsnooze-codex-gui/releases/tag/v1.20.1-henry-codex-gui.20261028). Chạy trong PowerShell trên Windows có Node.js 22 trở lên:

```powershell
npm.cmd install --global "https://github.com/dohoanghung055-art/unsnooze-codex-gui/releases/download/v1.20.1-henry-codex-gui.20261028/unsnooze-1.20.1-henry-codex-gui.20261028.tgz"
unsnooze.cmd setup
```

Trong setup, chọn Codex, bật auto-resume và bật guard GUI sessions. Đọc phần điều kiện bên dưới trước khi để máy chạy qua đêm.

Muốn xem mã nguồn hoặc chạy lại các kiểm tra:

```powershell
git clone https://github.com/dohoanghung055-art/unsnooze-codex-gui.git
Set-Location .\unsnooze-codex-gui
npm.cmd ci
node --test test/codex-desktop.test.js test/codex-desktop-resumer.test.js test/settings.test.js
```

Repo này là bản snapshot sạch để chia sẻ, không giữ lịch sử Git riêng tư của máy phát triển. Package npm được đính kèm ở Releases, không publish lên npm registry. Metadata repository trong package giữ tham chiếu upstream; repo của bản mod là link GitHub trên.

## Bản mod giải quyết gì?

Khi chat Codex Desktop hết quota, Unsnooze chờ tới thời điểm reset rồi gửi lời nhắc để chat tiếp tục. Những thay đổi ở đây tập trung vào việc đánh thức **đúng chat GUI đang có**, qua chính Codex Desktop.

### 1. Resume qua writer đang có của Codex Desktop

Một tiến trình `codex exec resume` riêng có thể xung đột với writer mà Desktop đang giữ, gây lỗi `thread-store conflict ... already has an active writer`.

Bản mod nhận diện session Windows có nguồn Codex Desktop và dùng công cụ `read_thread` / `send_message_to_thread` qua named pipe cục bộ của Desktop. Nó không mở một CLI writer thứ hai cho session GUI đó.

### 2. Giữ thiết lập riêng của chat

Đường GUI không gửi override model, reasoning effort hay quyền truy cập: Desktop tiếp tục quản lý thiết lập của chính chat đó. Đây không phải cơ chế nâng quyền hoặc chuyển mọi chat về cùng một cấu hình.

Đối với đường CLI được mở lại, bản fork cũng đọc thiết lập từ `turn_context`; nếu thiếu dữ liệu hoặc CLI không biểu diễn an toàn được thiết lập cũ, nó giữ lại lý do thay vì đoán một cấu hình rộng quyền hơn. Những thay đổi bổ sung của bản này vẫn tập trung chủ yếu vào GUI trên Windows.

### 3. Sửa việc tìm cổng sau thay đổi của Desktop

Hỗ trợ cả `codex-app-tools-*` hiện tại và tên cũ `codex-browser-use-*`. Ưu tiên cổng app-tools khi có nhiều cổng browser, kiểm tra công cụ thực sự được cung cấp, và yêu cầu một endpoint hợp lệ duy nhất.

### 4. Hạn chế gửi trùng

- Đọc lượt gần nhất trước khi gửi; nếu chat đã chạy lại hoặc đã hoàn tất, không đánh thức thêm.
- Chỉ tự gửi cho lượt được xác nhận là dừng do usage limit.
- Lưu claim trước khi gửi, rồi xác minh lượt mới.
- Nếu mất xác nhận giao nhận, xác minh tiếp nhưng không tự gửi lại một cách mù quáng. Trường hợp chưa xác định có thể được giữ ở trạng thái cần kiểm tra để tránh trùng.
- Nếu Desktop không khả dụng, giữ trạng thái chờ; không chuyển sang CLI writer cho session GUI đó.

### 5. Prompt dành cho lúc chủ máy vắng mặt

Prompt mặc định mới bằng tiếng Anh, có toàn văn trong `DEFAULT-RESUME-PROMPT.txt`. Nó nói rõ đây là lời nhắc tự động, yêu cầu không hỏi, tiếp tục các phần độc lập đã được cho phép, ghi lại bước cần người dùng rồi chuyển sang phần khác, và rà lại việc dang dở trước khi kết thúc.

Prompt không cấp thêm quyền và không bắt agent chạy vô hạn. Agent vẫn phải dừng khi đã hoàn tất, hết phần việc có thể làm độc lập hoặc gặp giới hạn thực thi thật.

### 6. Giữ bản mod khỏi lệnh self-update

Gói có marker `unsnoozePin`; lệnh `unsnooze update` từ chối tự thay bản fork bằng upstream. Việc cài đè bằng npm vẫn có thể thay thế bản mod, nên đừng chạy `npm install -g unsnooze` hoặc cập nhật package này từ registry nếu muốn giữ bản đang chia sẻ.

## Tự bật daemon khi mở session Work/Codex local

Hook tuỳ chọn đã có trên nhánh `main`. Sau khi cài gói Unsnooze, clone repo rồi chạy:

```powershell
git clone https://github.com/dohoanghung055-art/unsnooze-codex-gui.git
Set-Location .\unsnooze-codex-gui
node .\scripts\install-session-hook.mjs
```

Nếu đã clone, chỉ cần `git pull` rồi chạy installer. Script đọc vị trí npm global trên máy nhận, sao lưu cấu hình cần thay đổi, giữ các hook khác và không đăng ký trùng khi chạy lại. Không chứa đường dẫn riêng của máy Henry.

**Cần duyệt một lần:** mở Codex CLI, nhập `/hooks`, kiểm tra rồi Trust mục **Ensuring Unsnooze daemon is running**. Installer không tự cấp trust. Khi hook còn `untrusted`, nó chưa tự chạy.

Hook bắt sự kiện bắt đầu/mở lại/xoá lịch sử/fork của session local. Nếu daemon đang sống thì bỏ qua; nếu chưa có và Unsnooze vẫn bật on-demand thì khởi động daemon nền, ẩn console. Áp dụng cho Work local và Codex local; không áp dụng cho cloud orchestration hoặc từng lần đổi tab.

Mã hook: `hooks/unsnooze-session-start.cjs`. Có thêm 3 kiểm tra tập trung cho installer, bảo toàn cấu hình và vị trí package tuỳ chỉnh:

```powershell
node --test test/session-hook-install.test.js
```

Release `v1.20.1-henry-codex-gui.20261028` đã tải lên trước khi thêm hook; asset cũ được giữ nguyên. Cài hook từ mã nguồn `main` theo hướng dẫn trên. Các lần đóng gói tiếp theo sẽ kèm script và hook.

## Goal bị dừng sau rate limit

Resume một lượt chat không đủ để chứng minh vòng tự tiếp tục của Goal đã được bật lại. Bản này **chưa chủ động resume Goal**. Hiện hãy dùng **Resume** ở dòng Goal trong app hoặc `/goal resume` trong Codex CLI.

Đã xác nhận schema Codex có trạng thái `usageLimited` riêng, nhưng cổng app-tools đang dùng chưa cung cấp công cụ điều khiển Goal. Muốn hỗ trợ tự động đúng cách phải bổ sung đường điều khiển qua chính Desktop đang sở hữu chat, chỉ tiếp tục Goal bị quota chặn và giữ nguyên pause thủ công/ngân sách. Xem [kết quả điều tra và giới hạn bằng chứng](docs/goal-resume-investigation.md).

## Có gì trong ZIP trên Releases?

- `README.md`: hướng dẫn này.
- `unsnooze-1.20.1-henry-codex-gui.20261028.tgz`: gói cài npm.
- `DEFAULT-RESUME-PROMPT.txt`: prompt mới.
- `source/`: mã nguồn runtime, lockfile, tài liệu upstream và 3 tệp kiểm tra tập trung cho Desktop/settings.
- `LICENSE`: giấy phép gốc.
- `SHA256SUMS.txt`: checksum của gói npm.
- `VERIFICATION.json`: kết quả kiểm tra gói chia sẻ.

Không kèm `node_modules`, `.git`, chỉ mục tìm mã, config cá nhân, token, log hay lịch sử chat. Một định danh chat cố định trong fixture kiểm tra đã được đổi thành UUID giả. Dependency sẽ được npm tải trên máy nhận.

## Cài trên máy bạn

Chuẩn bị **Windows**, **Node.js 22 trở lên kèm npm** và Codex Desktop đã đăng nhập. Gói này được kiểm tra bằng Node.js 24.15.0. Bản share khai báo Node >=22 để khớp dependency Ink; metadata upstream 1.20.1 ban đầu ghi >=20.12.

Giải nén ZIP vào một thư mục, mở PowerShell tại đó, rồi chạy:

```powershell
npm.cmd install --global ".\unsnooze-1.20.1-henry-codex-gui.20261028.tgz"
unsnooze.cmd setup
```

Trong setup:

1. Chọn **Codex** trong danh sách agent, kể cả khi wizard không tự nhận CLI trong PATH.
2. Bật **auto-resume**.
3. Bật **guard GUI sessions** để khởi động daemon theo dõi.
4. Giữ prompt mặc định mới, hoặc chỉnh theo nhu cầu của bạn.

Setup có thể cài wrapper vào shell và hook theo agent đã chọn. Nếu đã cài Unsnooze trước đó, việc cài gói này thay phiên bản lệnh global; setup với GUI watching sẽ khởi động lại daemon để nạp mã mới. Cấu hình cũ được giữ, không sao chép cấu hình từ máy Henry.

Nếu đang có cấu hình cũ và muốn dùng prompt mới:

```powershell
unsnooze.cmd config set resumeMessage (Get-Content -Raw -LiteralPath '.\DEFAULT-RESUME-PROMPT.txt')
```

Một override khác rỗng tại `resumeMessages.codex`, biến môi trường hoặc bản ghi session có thể ưu tiên hơn prompt global. Kiểm tra bằng `unsnooze.cmd config` và `unsnooze.cmd preview`. Prompt global cũng áp dụng cho các agent khác nếu chúng không có override riêng.

Kiểm tra sau cài:

```powershell
unsnooze.cmd doctor
unsnooze.cmd status
unsnooze.cmd preview
```

`preview` là xem trước, không gửi lời nhắc. Khi chưa có session đang chờ quota, danh sách rỗng là bình thường; đây chưa phải kiểm chứng resume qua reset quota thật.

### Sau khi khởi động lại Windows

Bản này không đăng ký Scheduled Task tự chạy lúc đăng nhập Windows. Wrapper/hook có thể bật daemon theo nhu cầu. Nếu chỉ mở Codex GUI, hãy chủ động bật daemon nền lại:

```powershell
unsnooze.cmd install --yes --daemon
```

Hoặc chạy `unsnooze.cmd daemon` trong một terminal riêng. Dùng `status` để kiểm tra daemon; không mặc định rằng chỉ mở app GUI là daemon đã chạy.

## Điều kiện và giới hạn

- Giữ Codex Desktop mở, đăng nhập, máy thức và có mạng khi tới giờ reset. Unsnooze không tự đánh thức máy đang sleep.
- Không vượt quota, mua credit hay chuyển gói tài khoản; chỉ thử tiếp tục sau thời điểm reset được phát hiện.
- Cần Desktop cung cấp giao thức local app-tools phù hợp. Đây là tích hợp phụ thuộc giao thức nội bộ của Desktop; bản cập nhật app có thể làm nó thay đổi.
- Những phần GUI bổ sung chỉ được kiểm tra trên Windows. Hỗ trợ macOS/Linux và agent khác kế thừa từ upstream, không được đợt mod này xác minh lại toàn bộ.
- Không coi một lời nhắc tự động là sự chấp thuận cho đăng nhập, CAPTCHA, gửi/publish, chi tiêu hay hành động mới cần người dùng.
- Unsnooze đánh thức chat sau quota; không phải bộ điều phối liên tục. Nếu agent tự gửi câu trả lời cuối, Unsnooze không tự nhắc tiếp chỉ vì tác vụ có thể còn việc.
- Đã quan sát lỗi Windows `EPERM` khi đổi tên file state trong một số lần cleanup; bản mod này chưa xử lý riêng lỗi đó. Khi có `FAILED` hoặc giao nhận chưa xác định, đọc log và kiểm tra chat trước khi thử lại.

## Đã kiểm chứng tới đâu?

39 kiểm tra tập trung đi kèm bao phủ Desktop client/resumer và settings; xem kết quả của lần đóng gói trong `VERIFICATION.json`. Các kiểm tra gửi lời nhắc dùng mô phỏng, không đồng nghĩa với việc đã thử mọi bản Desktop.

Trên máy phát triển, log daemon sau bản sửa dò cổng ghi nhận các lần reset quota thật ngày 27–28/10/2026 đã gửi wake và xác minh lượt mới của chat chính. Một bản ghi chat con khác vẫn từng có giao nhận chưa xác định; không khẳng định mọi session đều thành công.

Prompt vắng mặt mới được kiểm tra cấu hình và thứ tự ưu tiên, chưa chứng minh nó ngăn mọi trường hợp agent dừng sớm. Gói chia sẻ chưa được kiểm thử trên máy người nhận. Không kèm log riêng tư làm bằng chứng trong ZIP.

Nếu dùng mã nguồn trong ZIP (thư mục `source/`), có thể chạy lại 39 kiểm tra như sau. Nếu clone repo GitHub, dùng hướng dẫn ở đầu README:

```powershell
Set-Location .\source
npm.cmd ci
node --test test/codex-desktop.test.js test/codex-desktop-resumer.test.js test/settings.test.js
```

## Gỡ bản mod

```powershell
unsnooze.cmd uninstall
npm.cmd uninstall --global unsnooze
```

Lệnh trên không dùng `--purge`, nên không chủ động xoá thư mục dữ liệu `~/.unsnooze`. Nếu quay lại bản chính thức, cài riêng từ upstream và kiểm tra lại cấu hình còn lưu.

## Những tệp chính đã thay đổi so với upstream

- `src/codex-desktop.js`: client local app-tools, dò endpoint và quyết định khi nào được wake.
- `src/resumer.js`: dispatch/claim/verify theo writer của Desktop, giữ khi giao nhận không rõ.
- `src/agents/codex.js`: đọc ngữ cảnh và thiết lập session để tiếp tục an toàn.
- `src/settings.js`: prompt vắng mặt mới.
- `src/update-check.js`, `package.json`: bảo vệ self-update của fork và metadata.
- `src/cli.js`: bổ sung hiển thị xem trước cho đường resume qua Desktop.
- Các tệp kiểm tra Desktop/settings và tài liệu fork.

Toàn bộ Unsnooze không phải do Henry viết lại. Các chức năng đa agent, watcher, dashboard và hạ tầng nền phần lớn là công việc upstream; phần mod ở đây tập trung vào đường resume Codex GUI và cách tiếp tục khi người dùng vắng mặt.
