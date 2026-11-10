# Listing texts

Every text that goes into a store form, in English and Arabic. Each field sits in a code block marked `field=…`; `npm run check:store` verifies the limits (and that the short description is the one in the manifest). Edit the text here, never only in the store form.

Voice: short, plain, honest. No superlatives, no "first", no "best". Say what it does **and** what it does not do.

---

## Name

```text field=name-en max=45
OnDemand for X (Twitter)
```

```text field=name-ar max=45
عند الطلب – OnDemand for X (Twitter)
```

Edge takes the name from the package (English). Firefox lets you set a name per language: use the Arabic one for the Arabic listing.

## Short description (the manifest `description`, also the Edge "short description")

```text field=manifest-description max=132
Your X (Twitter) timeline one batch at a time, only when you press the button. No endless scroll. Nothing hidden.
```

## Summary (Firefox, at most 250 characters)

```text field=amo-summary-en max=250
Gives X (Twitter)'s endless Home feed an end. You get the batch X sends; the next one is requested only when you press a button. Nothing hidden, nothing blocked, no reloads, no data collected.
```

```text field=amo-summary-ar max=250
تايملاينك عند الطلب: دفعة وحدة وبس. تويتر (X) يرسل لك دفعة، والدفعة اللي بعدها ما تنطلب إلا لما تضغط الزر. بدون إخفاء ولا حظر ولا جمع بيانات.
```

## Description — English (plain text; works in both stores)

```text field=description-en min=250 max=10000
Scroll one batch. Stop. Press a button when you want the next one.

X's Home feed never ends: when you reach the bottom, the page asks X for more posts by itself, again and again. OnDemand for X (Twitter) gives the feed an end. It holds back the one request X makes for the next page and sends it only when you press "Load a new batch".

WHAT YOU GET
• The Home timeline (For you and Following) stops at the end of the batch X sent you. Nothing arrives that you did not ask for.
• You can read, like, reply and scroll back through everything that already loaded, for as long as you like.
• Nothing hidden, nothing blocked: the next page simply waits for you (no reload and no error page in our tests).
• Interface in 14 languages: Arabic, English, Chinese (Simplified and Traditional), French, German, Indonesian, Japanese, Korean, Portuguese (Brazil), Russian, Spanish, Thai and Turkish. Most translations were drafted with AI and are waiting for review by native speakers.
• Private by design: no data collected, no network requests of its own, no account, no analytics. The only things stored are two settings (on/off and language), on your device.

WHY HOLD INSTEAD OF HIDE OR BLOCK?
Hiding posts still lets X deliver every page in the background. Blocking requests makes X show errors and retry. Holding the request leaves X alone: it just waits for you.

WHAT IT DOES NOT DO
It does not filter or remove posts, it does not choose how many posts a batch has (X decides), and it does not touch search, profiles, lists or notifications.

GOOD TO KNOW
• X changes its website without notice. When the extension cannot recognise what X is doing, it steps aside: X works as if the extension were not installed, and the small status chip says so. In Settings, the Diagnostics box gives a text you can copy when you report a problem.
• A small spinner under the last post is normal: X is waiting for an answer you have not asked for yet.
• OnDemand for X is an independent open-source project (MIT licence). It is not affiliated with, endorsed by or sponsored by X Corp. "X" and "Twitter" are trademarks of their owners and are used only to say which website the extension works with.
```

## Description — Arabic

```text field=description-ar min=250 max=10000
دفعة وحدة وبس.

تايملاين تويتر (X) ما له نهاية: كل ما وصلت آخر الصفحة يطلب الموقع منشورات جديدة لحاله، وتظل تنزل. «عند الطلب» يعطيه نهاية. يمسك الطلب الوحيد اللي يرسله تويتر لجلب الصفحة التالية، وما يطلقه إلا لما تضغط «جيب دفعة جديدة».

وش تستفيد؟
• تايملاينك («لك» و«أتابعه») يوقف عند آخر دفعة أرسلها لك تويتر. ما يوصلك شي ما طلبته.
• تقرأ وتحط لايكات وترد وترجع فوق في كل اللي وصلك، على راحتك.
• بدون إخفاء وبدون منع: الصفحة التالية تنتظرك بس (في اختباراتنا بدون إعادة تحميل وبدون صفحة خطأ).
• الواجهة بـ 14 لغة: العربية والإنجليزية والصينية (المبسطة والتقليدية) والفرنسية والألمانية والإندونيسية واليابانية والكورية والبرتغالية (البرازيل) والروسية والإسبانية والتايلندية والتركية. أغلب الترجمات كُتبت بالذكاء الاصطناعي وتنتظر مراجعة ناطقين أصليين.
• خصوصية كاملة: ما يجمع بيانات، ما يرسل شي لأي مكان، ما فيه حساب ولا تحليلات. كل اللي يحفظه إعدادان على جهازك (التشغيل واللغة).

ليش «نمسك الطلب» وما «نخفي» أو «نمنع»؟
إخفاء المنشورات يخلي تويتر يظل يحمّل الصفحات وراك. ومنع الطلب يطلّع «حدث خطأ ما» ويعيد المحاولة. مسك الطلب ما يلمس تويتر: ينتظر وبس.

وش ما يسوي؟
ما يخفي منشورات ولا يفلترها، وما يحدد كم منشور في الدفعة (تويتر يقرر)، وما يلمس البحث ولا الملفات الشخصية ولا القوائم ولا الإشعارات.

للعلم
• تويتر يغيّر موقعه بدون إنذار. إذا ما قدرت الإضافة تتعرف على اللي يسويه تويتر فإنها تتنحى: تويتر يشتغل مثل ما لو ما ركبتها، وشارة الحالة الصغيرة تقول لك. من الإعدادات افتح «تشخيص» وانسخ النص وأرسله لنا إذا صار خلل.
• دوّار التحميل الصغير تحت آخر منشور طبيعي: تويتر ينتظر رد ما طلبته بعد.
• مشروع مستقل ومفتوح المصدر (رخصة MIT). غير تابع لشركة X ولا مدعوم منها. «X» و«Twitter» علامات تجارية لأصحابها، وتُذكر هنا فقط لتوضيح الموقع الذي تعمل عليه الإضافة.
```

## Description for Microsoft Edge (one language in the store: English, then Arabic)

Edge only shows separate languages for packages that contain `_locales/` (this extension deliberately does not, see README in this folder). So the Edge description carries both, English first. Paste the English text above, then a blank line, a line `———`, a blank line and the Arabic text above.

## Search terms (Edge, not shown to users: at most 7 terms, 30 characters each, 21 words in all)

```text field=edge-search-terms
doomscroll
infinite scroll
twitter timeline
load more button
x.com feed
digital wellbeing
تويتر تايملاين
```

## Tags (Firefox)

```text field=amo-tags
twitter, x, timeline, doomscroll, infinite scroll, load more, digital wellbeing
```

## Release notes of the first store version

```text field=release-notes-en max=500
First public release. Holds the Home timeline's next page until you press "Load a new batch". Interface in 14 languages. No data collected.
```

```text field=release-notes-ar max=500
أول إصدار عام. يمسك الصفحة التالية من تايملاين الرئيسية إلى أن تضغط «جيب دفعة جديدة». الواجهة بـ 14 لغة. بدون جمع أي بيانات.
```

## Screenshot captions

The images are in `screenshots/` (1280×800). They show a **simulated** demo feed (made-up posts and people), which the first caption says. Firefox lets you caption each image per language.

| # | File | English | العربية |
|---|---|---|---|
| 1 | `1-one-batch-at-a-time.png` | One batch at a time (simulated demo feed) | دفعة واحدة كل مرة (تايملاين تجريبي) |
| 2 | `2-nothing-hidden.png` | Nothing hidden, nothing blocked | ما يُخفى شي وما يُمنع شي |
| 3 | `3-your-language.png` | Interface in 14 languages | الواجهة بـ 14 لغة |
| 4 | `4-made-for-phones.png` | Made for small screens too | مصمّمة للجوال كمان |
| 5 | `5-diagnostics.png` | Steps aside when X changes; copyable diagnostics | تتنحى إذا غيّر تويتر شي، ومعها نص تشخيص تنسخه |
