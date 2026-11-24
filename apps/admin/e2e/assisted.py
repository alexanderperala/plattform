import hmac,hashlib,base64,struct,time,random
from playwright.sync_api import sync_playwright
def totp(s,off=0):
    k=base64.b32decode(s); c=int(time.time())//30+off
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
SH="/home/claude/plattform/docs/screenshots/"
tag=str(random.randint(1000,9999)); email=f"e2e{tag}@example.test"; org=f"E2E Assist {tag}"
SEC="JBSWY3DPEHPK3PXP"
with sync_playwright() as p:
    b=p.chromium.launch()
    cu=b.new_page(viewport={"width":1300,"height":900}); cu.goto("http://127.0.0.1:5174/")
    cu.click("text=Skapa konto"); cu.fill("form input >> nth=0","Eva Ekonomi"); cu.fill("input[type=email]",email); cu.fill("input[type=password]","Kundlösenord-2026")
    cu.fill("form >> input >> nth=3",org); cu.check("text=Jag godkänner villkoren"); cu.click("button:has-text('Skapa konto')")
    cu.wait_for_selector(f"h1:has-text('{org}')"); print("kund registrerad")
    ad=b.new_page(viewport={"width":1300,"height":900}); ad.goto("http://127.0.0.1:5173/")
    ad.fill('input[type=email]',"support@example.test"); ad.fill('input[type=password]',"DevAdminPassword!2026"); ad.click("text=Fortsätt")
    ad.wait_for_selector("text=Tvåstegsverifiering"); ad.fill("input",totp(SEC)); ad.click("button:has-text('Verifiera')"); ad.wait_for_selector("h1:has-text('Översikt')")
    ad.click("nav a[href='/customers']"); ad.fill("input[type=search]",org); ad.wait_for_selector(f"tbody tr:has-text('{org}')"); ad.click(f"tbody tr:has-text('{org}')"); ad.wait_for_selector("text=Kunduppgifter")
    ad.click("button[role=tab]:has-text('Support')"); ad.click("button:has-text('Nytt ärende')"); ad.fill("div.modal input","Slå på forum och fixa kontaktuppgift"); ad.click("div.modal button:has-text('Skapa ärende')")
    ad.wait_for_selector("h1:has-text('Slå på forum')"); ad.go_back(); ad.wait_for_selector("button[role=tab]"); ad.click("button[role=tab]:has-text('Support')")
    def start():
        ad.select_option("select[aria-label='Ärende']",index=1); ad.select_option("select[aria-label='Läge']","assisted")
        ad.click("div.card:has-text('Supportåtkomst') button:has-text('Starta session')")
        ad.fill("div.modal textarea","Hjälper kunden enligt ärendet med konfiguration")
        ad.click("div.modal button:has-text('Starta session')")
    def reauth_if_asked(btn):
        try:
            ad.wait_for_selector("div.modal input[autocomplete=one-time-code]",timeout=2500)
        except Exception: return
        ad.fill("div.modal input[autocomplete=one-time-code]",totp(SEC,1)); ad.click(f"div.modal button:has-text('{btn}')")
    start(); reauth_if_asked('Starta session')
    ad.wait_for_selector("div.modal .alert",timeout=5000); print("utan kundens godkännande:", ad.inner_text("div.modal .alert")[:100]); ad.click("div.modal button:has-text('Avbryt')")
    cu.click("nav a:has-text('Supportåtkomst')"); cu.click("button:has-text('Godkänn assisterad support')")
    cu.check("text=Aktivera behörighet"); cu.check("text=Ändra felaktig inställning"); cu.screenshot(path=SH+"customer-assisted-grant.png")
    cu.click("div.modal button:has-text('Ge godkännande')"); cu.wait_for_selector("text=Aktivt"); print("kund godkände assisterad support")
    ad.reload(); ad.wait_for_selector("button[role=tab]"); ad.click("button[role=tab]:has-text('Support')"); start(); reauth_if_asked('Starta session')
    ad.wait_for_selector("text=ASSISTERAD SUPPORTSESSION",timeout=8000); print("assisterad session öppen")
    # åtgärd 1: slå på flagga
    ad.click("div.card:has-text('Åtgärder för kundens räkning') div.row:has-text('Konfigurera funktion') button:has-text('Utför')")
    ad.fill("div.modal textarea","Kunden bad om att få testa nya forumet"); ad.click("div.modal button:has-text('Utför')"); reauth_if_asked('Utför')
    ad.wait_for_selector("div.row:has-text('association.forum_v2') .badge:has-text('På')",timeout=8000); print("flagga på")
    # åtgärd 2: ändra kontaktperson
    ad.fill("input[aria-label='Kontaktperson']","Rätt Kontakt"); ad.click("div.row:has-text('Ändra inställning') button:has-text('Utför')")
    ad.fill("div.modal textarea","Felstavat namn rättat enligt kundens önskemål"); ad.click("div.modal button:has-text('Utför')"); reauth_if_asked('Utför')
    ad.wait_for_selector("input[aria-label='Kontaktperson'][value='']",timeout=8000); print("kontaktuppgift ändrad")
    # funktionen som kunden inte tillät syns inte
    print("konfigurera-funktion tillåten ej:", ad.locator("strong:has-text('Konfigurera funktion')").count()==1)
    ad.screenshot(path=SH+"admin-assisted-session.png",full_page=True)
    cu.click("nav a:has-text('Översikt')"); cu.wait_for_selector("text=utförde en åtgärd",timeout=6000); print("kund notifierad:", cu.locator("text=utförde en åtgärd").count())
    cu.click("nav a:has-text('Supportåtkomst')"); cu.wait_for_selector("tbody tr:has-text('Assisterad')"); cu.screenshot(path=SH+"customer-assisted-history.png",full_page=True)
    cu.click("button:has-text('Återkalla godkännandet')"); cu.wait_for_selector("button:has-text('Godkänn assisterad support')")
    ad.click("div.row:has-text('Konfigurera funktion') button:has-text('Utför')")
    ad.fill("div.modal textarea","Försök efter återkallelse ska nekas"); ad.click("div.modal button:has-text('Utför')"); reauth_if_asked('Utför')
    ad.wait_for_selector("div.modal .alert",timeout=6000); print("efter återkallelse:", ad.inner_text("div.modal .alert")[:100])
    b.close()
