# PeerCall

เว็บเดโมโทร **เสียง + วิดีโอ** แบบ Peer-to-Peer ด้วย **PeerJS + WebRTC** ไม่มีฐานข้อมูลและไม่มี backend ของโปรเจกต์นี้ที่ต้องตั้งค่าเอง

## วิธีทดลองบนมือถือ

1. สร้าง repository บน GitHub
2. อัปโหลด `index.html`, `style.css`, `app.js`
3. เปิด Vercel แล้ว Import repository
4. Deploy
5. เปิด URL จากมือถือเครื่อง A และ B
6. แต่ละเครื่องจะได้ `Peer ID ของคุณ`
7. คัดลอก ID ของเครื่อง B ไปใส่ในเครื่อง A แล้วเลือก `วิดีโอ` หรือ `เสียง`
8. กด `โทรออก`
9. ที่เครื่อง B กด `รับสาย`

ไม่ต้องสร้าง Firebase project และไม่ต้องติดตั้ง Node.js เพื่อทดลองเดโมนี้

## สำคัญเรื่องความฟรี

PeerJS ใช้ PeerServer Cloud สำหรับ signaling โดยค่าเริ่มต้นในตัวอย่างนี้ การส่งเสียง/วิดีโอหลังเชื่อมต่อจะพยายามวิ่งตรงระหว่างอุปกรณ์ด้วย WebRTC

คำว่า `ฟรี 100%` ไม่สามารถรับประกันว่าเชื่อมต่อได้ทุกเครือข่าย เพราะ WebRTC บางกรณี เช่น symmetric NAT ต้องพึ่ง TURN relay และ TURN อาจมีค่าใช้บริการเมื่อใช้งานจริง

## ก่อนขึ้น Production

- เปลี่ยนจาก PeerServer Cloud ไป PeerServer ของตัวเองเมื่อมีผู้ใช้จำนวนมาก
- ตั้งค่า TURN สำหรับเครือข่ายที่เชื่อมต่อ P2P ไม่ได้
- เพิ่มระบบบัญชีผู้ใช้/รายชื่อเพื่อนแทนการเผยแพร่ Peer ID แบบสาธารณะ
- อย่าใช้ Peer ID เป็นตัวระบุผู้ใช้ถาวร เพราะ PeerJS ระบุว่า ID มีไว้สำหรับการ broker connection เป็นหลัก

## ไฟล์

- `index.html` — โครงหน้าเว็บ
- `style.css` — UI responsive สำหรับมือถือ
- `app.js` — PeerJS/WebRTC, โทรออก, รับสาย, mute, กล้อง และวางสาย

## เทคโนโลยี

- PeerJS 1.5.4 ผ่าน CDN
- WebRTC MediaStream
- PeerServer Cloud
- Vanilla HTML/CSS/JavaScript
