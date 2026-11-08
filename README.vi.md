# offload-mcp-server (tiếng Việt, tóm tắt)

Hướng dẫn đầy đủ, chi tiết từng bước nằm ở [README.md](README.md) (tiếng Anh). File này là bản tóm tắt.

MCP server cho phép agent chính (ví dụ Claude Code) **giao việc đọc nặng** cho một agent CLI khác chạy
nền (mặc định là Antigravity CLI `agy` với agent chỉ đọc `offload-reader`), rồi chỉ đọc lại báo cáo ngắn.

Ví dụ đã đo: kiểm kê 37 file PHP (khoảng 40 nghìn token nếu tự đọc). Claude chỉ tốn khoảng 0,5 nghìn token
cho phần Summary, hoặc 6,5 nghìn nếu đọc thêm Findings. Đổi lại phải chờ khoảng 8 phút.

## Cài đặt (9 bước, chi tiết trong README.md)

1. `npm install`, `npm run build`, `npm run smoke`.
2. Cài `agy` và đăng nhập Google (chạy `agy` một lần).
3. Chép `agents/offload-reader.md` vào `~/.gemini/agents/`, lưu UTF-8 **không BOM**, kiểm tra bằng `agy agents`.
4. Tạo `~/.offload/config.json` theo `offload.config.example.json`. Nên dùng **đường dẫn đầy đủ** tới `agy.exe`.
5. `node dist/index.js doctor`.
6. Thử: `npm run try -- "<thư mục dự án>" "<câu hỏi>" <thư mục con>`.
7. `claude mcp add --scope user offload -- node <đường dẫn>/dist/index.js`.
8. Chép `skills/offload/SKILL.md` vào `~/.claude/skills/offload/`.
9. Mở phiên Claude Code mới, gõ `/mcp` để thấy `offload` đã kết nối.

## Lưu ý quan trọng

- Ở chế độ chạy nền, `agy` không xin phép được. Nếu agent mặc định thử chạy lệnh terminal, lệnh bị từ chối
  và nó trả về **câu trả lời rỗng kèm exit code 0**. Vì vậy phải dùng agent `offload-reader`.
- Server tự đưa danh sách file trong phạm vi (`git ls-files`) vào prompt. Nếu không có danh sách này, worker
  sẽ đọc lan man. Hãy luôn truyền `paths` thật hẹp.
- Kết quả do model khác viết: chỉ để tham khảo, cần mở các dòng `path:line` được trích để kiểm tra lại.
- Worker gửi nội dung file nó đọc tới nhà cung cấp model (Google). Đừng giao việc trên dữ liệu không được chia sẻ.
