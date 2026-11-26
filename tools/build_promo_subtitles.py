#!/usr/bin/env python3
"""Subtitles of the home page video (site/pages/assets/promo.mp4), one WebVTT file per language.
The English text is the narration (transcribed with whisper.cpp, timings from its word timestamps).
Run after changing a line: python3 tools/build_promo_subtitles.py  (writes site/pages/assets/promo/<lang>.vtt)"""
import pathlib

TIMES = ["00:00.000 --> 00:03.000", "00:03.000 --> 00:05.500", "00:05.500 --> 00:09.200", "00:09.200 --> 00:13.000",
         "00:13.000 --> 00:15.640", "00:15.640 --> 00:18.200", "00:18.200 --> 00:20.120", "00:20.120 --> 00:22.840",
         "00:22.840 --> 00:24.960", "00:24.960 --> 00:26.880", "00:26.880 --> 00:29.260", "00:29.260 --> 00:31.700"]

LINES = {
 "en": ["A wrong amount on a PDF invoice?", "Most online editors upload your file,", "then hide the old words under a white box.",
        "Meet Quicktou.ch, a free editor\nthat runs in your browser.", "Edit text: click any word and type", "in the same font, size and colour.",
        "Find and replace: change a date", "or an amount everywhere at once.", "Sign it without printing.", "No install, no watermark,",
        "and your files never leave your computer.", "Open the editor."],
 "fr": ["Un montant erroné sur une facture PDF ?", "La plupart des éditeurs en ligne envoient votre fichier,", "puis cachent les anciens mots sous un cadre blanc.",
        "Voici Quicktou.ch, un éditeur gratuit\nqui fonctionne dans votre navigateur.", "Modifiez le texte : cliquez sur un mot et tapez", "dans la même police, la même taille et la même couleur.",
        "Rechercher et remplacer : changez une date", "ou un montant partout à la fois.", "Signez sans imprimer.", "Sans installation, sans filigrane,",
        "et vos fichiers ne quittent jamais votre ordinateur.", "Ouvrir l'éditeur."],
 "es": ["¿Un importe erróneo en una factura PDF?", "La mayoría de los editores en línea suben tu archivo", "y luego tapan las palabras antiguas con un recuadro blanco.",
        "Te presentamos Quicktou.ch, un editor gratuito\nque funciona en tu navegador.", "Edita el texto: haz clic en una palabra y escribe", "con la misma fuente, tamaño y color.",
        "Buscar y reemplazar: cambia una fecha", "o un importe en todas partes a la vez.", "Fírmalo sin imprimir.", "Sin instalación, sin marca de agua,",
        "y tus archivos nunca salen de tu ordenador.", "Abrir el editor."],
 "pt": ["Um valor errado em uma fatura PDF?", "A maioria dos editores online envia o seu arquivo", "e depois esconde as palavras antigas sob uma caixa branca.",
        "Conheça o Quicktou.ch, um editor gratuito\nque funciona no seu navegador.", "Edite o texto: clique em qualquer palavra e digite", "com a mesma fonte, tamanho e cor.",
        "Localizar e substituir: mude uma data", "ou um valor em todo lugar de uma vez.", "Assine sem imprimir.", "Sem instalação, sem marca d'água,",
        "e seus arquivos nunca saem do seu computador.", "Abrir o editor."],
 "de": ["Ein falscher Betrag auf einer PDF-Rechnung?", "Die meisten Online-Editoren laden Ihre Datei hoch", "und verstecken die alten Wörter unter einem weißen Kasten.",
        "Das ist Quicktou.ch, ein kostenloser Editor,\nder in Ihrem Browser läuft.", "Text bearbeiten: Wort anklicken und tippen,", "in derselben Schrift, Größe und Farbe.",
        "Suchen und ersetzen: Ändern Sie ein Datum", "oder einen Betrag überall auf einmal.", "Unterschreiben, ohne zu drucken.", "Keine Installation, kein Wasserzeichen,",
        "und Ihre Dateien verlassen nie Ihren Computer.", "Editor öffnen."],
 "nl": ["Een verkeerd bedrag op een PDF-factuur?", "De meeste online editors uploaden je bestand", "en verbergen de oude woorden onder een wit vak.",
        "Maak kennis met Quicktou.ch, een gratis editor\ndie in je browser werkt.", "Tekst bewerken: klik op een woord en typ", "in hetzelfde lettertype, dezelfde grootte en kleur.",
        "Zoeken en vervangen: wijzig een datum", "of een bedrag overal tegelijk.", "Onderteken zonder te printen.", "Geen installatie, geen watermerk,",
        "en je bestanden verlaten nooit je computer.", "Open de editor."],
 "it": ["Un importo sbagliato in una fattura PDF?", "La maggior parte degli editor online carica il tuo file", "e poi nasconde le vecchie parole sotto un riquadro bianco.",
        "Ecco Quicktou.ch, un editor gratuito\nche funziona nel tuo browser.", "Modifica il testo: fai clic su una parola e scrivi", "con lo stesso carattere, dimensione e colore.",
        "Trova e sostituisci: cambia una data", "o un importo ovunque in una volta.", "Firma senza stampare.", "Niente installazione, niente filigrana,",
        "e i tuoi file non lasciano mai il tuo computer.", "Apri l'editor."],
 "pl": ["Błędna kwota na fakturze PDF?", "Większość edytorów online wysyła Twój plik na serwer,", "a potem zakrywa stare słowa białym prostokątem.",
        "Poznaj Quicktou.ch, darmowy edytor,\nktóry działa w Twojej przeglądarce.", "Edytuj tekst: kliknij dowolne słowo i pisz", "tą samą czcionką, rozmiarem i kolorem.",
        "Znajdź i zamień: zmień datę", "lub kwotę wszędzie naraz.", "Podpisz bez drukowania.", "Bez instalacji, bez znaku wodnego,",
        "a Twoje pliki nigdy nie opuszczają komputera.", "Otwórz edytor."],
 "ar": ["مبلغ خاطئ في فاتورة PDF؟", "معظم المحرّرات على الإنترنت ترفع ملفك،", "ثم تخفي الكلمات القديمة تحت مربع أبيض.",
        "تعرّف على Quicktou.ch، محرّر مجاني\nيعمل في متصفحك.", "حرّر النص: انقر على أي كلمة واكتب", "بالخط والحجم واللون نفسها.",
        "البحث والاستبدال: غيّر تاريخًا", "أو مبلغًا في كل مكان دفعة واحدة.", "وقّعه من دون طباعة.", "لا تثبيت، ولا علامة مائية،",
        "وملفاتك لا تغادر حاسوبك أبدًا.", "فتح المحرر."],
 "he": ["סכום שגוי בחשבונית PDF?", "רוב העורכים המקוונים מעלים את הקובץ שלך", "ואז מסתירים את המילים הישנות מתחת לריבוע לבן.",
        "הכירו את Quicktou.ch, עורך חינמי\nשפועל בדפדפן שלך.", "עריכת טקסט: לוחצים על מילה ומקלידים", "באותו גופן, גודל וצבע.",
        "חיפוש והחלפה: משנים תאריך", "או סכום בכל המקומות בבת אחת.", "חותמים בלי להדפיס.", "בלי התקנה, בלי סימן מים,",
        "והקבצים שלך אף פעם לא יוצאים מהמחשב.", "פתיחת העורך."],
 "zh": ["PDF 发票上的金额写错了？", "大多数在线编辑器会上传你的文件，", "再用白框盖住原来的文字。",
        "试试 Quicktou.ch：一款免费的编辑器，\n直接在浏览器中运行。", "编辑文字：点击任意文字直接输入，", "字体、字号和颜色都保持不变。",
        "查找和替换：一次性修改", "所有位置的日期或金额。", "无需打印即可签名。", "无需安装，没有水印，",
        "你的文件也从不离开你的电脑。", "打开编辑器"],
 "ja": ["PDF の請求書の金額が間違っている？", "多くのオンラインエディタはファイルをアップロードし、", "古い文字を白い四角で隠すだけです。",
        "Quicktou.ch なら、無料のエディタが\nブラウザの中で動きます。", "テキスト編集：文字をクリックして入力すると、", "同じフォント、サイズ、色になります。",
        "検索と置換：日付や金額を", "すべての場所で一度に変更できます。", "印刷せずに署名できます。", "インストール不要、透かしなし。",
        "ファイルがコンピュータの外に出ることはありません。", "エディタを開く"],
}

out = pathlib.Path(__file__).resolve().parent.parent / "site" / "pages" / "assets" / "promo"
out.mkdir(parents=True, exist_ok=True)
for lang, lines in LINES.items():
    assert len(lines) == len(TIMES), lang
    assert all("Quicktou" not in l or "Quicktou.ch" in l for l in lines), lang      # the brand is always written in full
    body = "WEBVTT\n\n" + "\n\n".join(f"{i + 1}\n{t}\n{l}" for i, (t, l) in enumerate(zip(TIMES, lines))) + "\n"
    (out / f"{lang}.vtt").write_text(body)
print("subtitles:", ", ".join(LINES))
