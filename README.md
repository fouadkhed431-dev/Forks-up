# Forks Up — HALL NO. 213

**United We Eat. Divided We Pay.**

تطبيق ويب عربي RTL لإدارة طلبات الطعام الجماعية داخل المكتب. المسؤول فقط يحتاج إلى التطبيق؛ الموظفون يفتحون رابط الجولة أو يمسحون QR Code من الهاتف، دون تنزيل التطبيق أو إنشاء حساب.

## المزايا الموجودة

- لوحة مسؤول محمية بتسجيل الدخول عبر Supabase Auth.
- إنشاء جولات طعام وتحديد نوع الطعام وموعد إغلاق الطلبات.
- إرفاق منيو المطعم كصورة JPG / PNG / WEBP أو PDF (حتى 10 MB).
- رابط فريد وQR Code لكل جولة، مع مشاركة الرابط عبر WhatsApp.
- صفحة طلبات للموظفين تعمل على الهاتف وباللغة العربية.
- الموظف يرسل طلباً واحداً باسمه في الجولة، ويمكنه إضافة عدة أصناف.
- كل صنف فردي أو مشترك؛ صاحب الطلب يدخل تلقائياً ضمن المشاركين في الصنف المشترك.
- منع الطلبات المكررة بالاسم نفسه داخل الجولة.
- تعديل أو حذف طلب الموظف بواسطة المسؤول قبل إغلاق الجولة أو انتهاء الموعد.
- تسجيل عمليات التعديل والحذف في سجل خاص.
- تجميع الأصناف المتطابقة والكميات المطلوبة للمطعم.
- إدخال سعر الوحدة من الفاتورة الفعلية.
- حساب الفردي بالكامل على صاحبه، وتقسيم المشترك بالتساوي على المشاركين المحددين.
- تقسيم التوصيل والمصاريف الإضافية بالتساوي على جميع المشاركين في الجولة.
- كشف حساب مفصل لكل شخص وإرساله عبر WhatsApp.
- تحديث مباشر للوحة المسؤول عند وصول طلبات جديدة.
- تطبيق PWA قابل للتثبيت على Android للمسؤول.

## المتطلبات

- Node.js 20 أو أحدث.
- مشروع Supabase مجاني أو مدفوع.
- استضافة HTTPS مثل Vercel أو Netlify حتى يتمكن الموظفون من فتح رابط الجولة من هواتفهم.

## الإعداد مرة واحدة

### 1) إعداد قاعدة البيانات

1. أنشئ مشروعاً في Supabase.
2. افتح **SQL Editor**.
3. افتح الملف:
   `supabase/migrations/202611170001_initial_schema.sql`
4. انسخ محتواه كاملاً ونفّذه مرة واحدة في SQL Editor.
5. من **Authentication → Users** أنشئ حساب المسؤول بالبريد وكلمة المرور. لا يحتاج الموظفون إلى حسابات.
6. تأكد أن حساب المسؤول مؤكد (Confirmed).

ملف SQL ينشئ الجداول والفهارس وسياسات RLS ودوال إرسال الطلبات العامة الآمنة وسجل التعديلات ومخزن ملفات المنيو. لا يحتاج الموظفون إلى صلاحية قراءة طلبات الآخرين؛ يرسلون الطلب من خلال دالة قاعدة بيانات مخصصة.

### 2) إعداد مفاتيح الاتصال

من **Project Settings → API** في Supabase انسخ:
- Project URL
- Publishable key أو anon/public key

أنشئ ملفاً اسمه `.env` في جذر المشروع، بجانب `package.json`، وضع فيه:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

استبدل القيم بالقيم الحقيقية من مشروعك. لا ترفع ملف `.env` إلى GitHub.

**مهم جداً:** لا تستخدم `service_role` أو `secret key` في التطبيق أو في متغيرات الواجهة. التطبيق يحتاج المفتاح العام فقط، والحماية تنفذها سياسات قاعدة البيانات.

### 3) تثبيت الحزم والاختبار والبناء

من داخل مجلد المشروع:

```bash
npm install
npm test
npm run build
```

لتشغيل نسخة محلية للمعاينة:

```bash
npm run dev
```

## النشر والتثبيت على Android

1. ارفع ملفات المشروع إلى جذر مستودع GitHub، بحيث يكون `package.json` في جذر المستودع وليس داخل مجلد فرعي.
2. اربط المستودع مع Vercel أو Netlify.
3. أضف متغيري البيئة `VITE_SUPABASE_URL` و`VITE_SUPABASE_ANON_KEY` في إعدادات الاستضافة نفسها.
4. إعدادات البناء:
   - Build command: `npm run build`
   - Output directory: `dist`
5. بعد النشر افتح رابط التطبيق من Chrome على هاتف المسؤول، ثم اختر **Install app** أو **Add to Home screen**.
6. سجّل الدخول بحساب المسؤول الذي أنشأته في Supabase.
7. أنشئ جولة، ثم افتح تبويب **مشاركة الجولة** وأرسل QR Code أو الرابط للموظفين.

الموظفون يفتحون رابط الجولة المنشور مباشرة من WhatsApp أو الكاميرا. لا يحتاجون إلى تثبيت Forks Up أو إنشاء حساب.

## قواعد الحساب المعتمدة

- الصنف الفردي: كامل السعر على صاحب الطلب.
- الصنف المشترك: سعر الصنف × الكمية، ثم يقسم بالتساوي على صاحب الطلب وبقية الأسماء التي اختارها.
- التوصيل والمصاريف الإضافية: تقسم بالتساوي على جميع الأشخاص المشاركين في الجولة، بمن فيهم من تمت إضافتهم إلى صنف مشترك ولم يرسلوا طلباً منفصلاً.
- فروق القروش الناتجة عن التقسيم توزع بحيث يظل مجموع كشوف الأشخاص مطابقاً لإجمالي الفاتورة.
- لا يمكن تعديل الطلب أو حذفه بعد إغلاق الجولة أو تجاوز موعدها.

## الملفات المهمة

- `src/` واجهة التطبيق ومنطق الحسابات والاتصال بقاعدة البيانات.
- `supabase/migrations/` مخطط قاعدة البيانات وسياسات الأمان والدوال.
- `tests/` اختبارات قواعد الحساب.
- `public/` شعار التطبيق وملفات PWA.
- `.env.example` مثال لمتغيرات الاتصال دون أي أسرار.

## ملاحظات الأمان

- لا يوجد تسجيل عام للموظفين.
- لا يمكن للزائر قراءة طلبات زملائه.
- كل مسؤول يرى الجولات التي أنشأها فقط.
- إرسال الطلبات العامة وتعديلها يمر عبر دوال SQL تتحقق من رمز الجولة وحالتها.
- لا تضع مفاتيح Supabase السرية في GitHub أو داخل ملفات الواجهة.


## Unified upgrade (2026-11-18)

The unified feature update adds a Supabase migration at
`supabase/migrations/202611180001_unified_upgrade.sql`.

**Before using the updated app, run this migration once** in the Supabase SQL Editor for the connected project. It adds:
- Financial settlement state for closed rounds.
- Per-participant payments (including people who only join a shared item).
- Employee directory and favorite food items.
- Admin RPCs for round settlement and safe, owner-scoped JSON backup restoration.
- Admin order corrections remain available after public ordering closes and before settlement.

The app also includes JSON backup export/restore, order statistics, round duplication, logo-branded invoice images, browser notifications while the admin dashboard is open, and a QA checklist covering the new workflows.

Browser notifications are local to the active browser session; remote push notifications while the app is closed require separate push-service credentials and server-side setup.
