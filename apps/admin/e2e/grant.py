import hmac,hashlib,base64,struct,time,random
from playwright.sync_api import sync_playwright
def totp(s):
    k=base64.b32decode(s); c=int(time.time())//30
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
SH="/home/claude/plattform/docs/screenshots/"
tag=str(random.randint(1000,9999)); email=f"e2e{tag}@example.test"; org=f"E2E Förening {tag}"
with sync_playwright() as p:
    b=p.chromium.launch()
    cu=b.new_page(viewport={"width":1300,"height":850}); cu.goto("http://127.0.0.1:5174/")
    cu.click("text=Skapa konto"); cu.fill("form input >> nth=0","Eva Ekonomi"); cu.fill("input[type=email]",email); cu.fill("input[type=password]","Kundlösenord-2026")
    cu.fill("form >> input >> nth=3",org); cu.check("text=Jag godkänner villkoren"); cu.click("button:has-text('Skapa konto')")
    cu.wait_for_selector(f"h1:has-text('{org}')"); print("kund registrerad och inloggad")
    cu.click("nav a:has-text('Supportåtkomst')"); cu.wait_for_selector("text=Inget aktivt godkännande"); cu.screenshot(path=SH+"customer-support-access-before.png")
    ad=b.new_page(viewport={"width":1300,"height":850}); ad.goto("http://127.0.0.1:5173/")
    ad.fill('input[type=email]',"support@example.test"); ad.fill('input[type=password]',"DevAdminPassword!2026"); ad.click("text=Fortsätt")
    ad.wait_for_selector("text=Tvåstegsverifiering"); ad.fill("input",totp("JBSWY3DPEHPK3PXP")); ad.click("button:has-text('Verifiera')"); ad.wait_for_selector("h1:has-text('Översikt')")
    ad.click("nav a[href='/customers']"); ad.fill("input[type=search]",org); ad.wait_for_selector(f"tbody tr:has-text('{org}')"); ad.click(f"tbody tr:has-text('{org}')"); ad.wait_for_selector("text=Kunduppgifter")
    ad.click("button[role=tab]:has-text('Support')"); ad.click("button:has-text('Nytt ärende')"); ad.fill("div.modal input","Behöver hjälp med medlemslistan"); ad.click("div.modal button:has-text('Skapa ärende')")
    ad.wait_for_selector("h1:has-text('Behöver hjälp')"); ad.go_back(); ad.wait_for_selector("button[role=tab]"); ad.click("button[role=tab]:has-text('Support')")
    def start_session():
        ad.select_option("select[aria-label='Ärende']",index=1); ad.check("text=Inkludera personuppgifter"); ad.click("div.card:has(h2:has-text('Supportåtkomst')) button:has-text('Starta session')")
        ad.fill("div.modal textarea","Hjälper kunden med medlemslistan enligt ärendet"); ad.click("div.modal button:has-text('Starta session')")
    start_session(); ad.wait_for_selector("div.modal .alert",timeout=5000); print("utan godkännande nekas:", ad.inner_text("div.modal .alert")[:90]); ad.click("div.modal button:has-text('Avbryt')")
    cu.click("button:has-text('Ge godkännande')"); cu.click("div.modal button:has-text('Ge godkännande')"); cu.wait_for_selector("text=Aktivt"); print("kund gav godkännande"); cu.screenshot(path=SH+"customer-support-access-granted.png")
    ad.reload(); ad.wait_for_selector("button[role=tab]"); ad.click("button[role=tab]:has-text('Support')"); start_session()
    ad.wait_for_selector("text=SKRIVSKYDDAD SUPPORTVY"); ad.wait_for_selector("th:has-text('Telefon')"); print("admin ser medlemmar med personuppgifter (maskerad telefon)"); ad.screenshot(path=SH+"admin-support-view-personal.png")
    cu.click("button:has-text('Återkalla godkännandet')"); cu.wait_for_timeout(1500); print(cu.inner_text("main")[:600]); cu.wait_for_selector("text=Inget aktivt godkännande"); print("kund återkallade")
    ad.reload(); ad.wait_for_selector("text=Supportsessionen är avslutad",timeout=6000); print("admin: session avslutad direkt efter återkallelse")
    cu.reload(); cu.wait_for_selector("text=Historik över supportåtkomst"); cu.wait_for_selector("tbody tr:has-text('Sara')"); cu.screenshot(path=SH+"customer-support-access-after.png")
    cu.click("nav a:has-text('Översikt')"); cu.wait_for_selector("text=Notiser"); print("notiser:", [x.inner_text() for x in cu.query_selector_all("ul.timeline strong")])
    b.close()
