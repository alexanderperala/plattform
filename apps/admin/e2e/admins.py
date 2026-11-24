import hmac,hashlib,base64,struct,time,random,glob,re,os
from playwright.sync_api import sync_playwright
def totp(s):
    k=base64.b32decode(s.replace(" ","").upper()+"="*((8-len(s.replace(" ",""))%8)%8)); c=int(time.time())//30
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
S="JBSWY3DPEHPK3PXP"; SH="/home/claude/plattform/docs/screenshots/"
tag=random.randint(1000,9999); email=f"ny{tag}@example.test"; PW="Ett-långt-lösenord-2026"
def login(pg,e,p="DevAdminPassword!2026",secret=S):
    pg.goto("http://127.0.0.1:5173/"); pg.fill('input[type=email]',e); pg.fill('input[type=password]',p); pg.click("text=Fortsätt")
    pg.wait_for_selector("text=Tvåstegsverifiering"); pg.fill("input",totp(secret)); pg.click("button:has-text('Verifiera')"); pg.wait_for_selector("h1:has-text('Översikt')")
with sync_playwright() as p:
    b=p.chromium.launch(); ow=b.new_page(viewport={"width":1300,"height":850}); login(ow,"owner@example.test")
    ow.click("nav a[href='/admins']"); ow.wait_for_selector("h1:has-text('Administratörer')"); ow.screenshot(path=SH+"admins.png")
    ow.click("button:has-text('Bjud in administratör')"); ow.fill("div.modal input[type=text], div.modal input:not([type])",f"Nina Ny {tag}"); ow.fill("div.modal input[type=email]",email)
    ow.select_option("div.modal select","billing_admin"); ow.fill("div.modal textarea","Ny kollega på ekonomi, behöver faktureringsåtkomst"); ow.click("div.modal button:has-text('Begär skapande')")
    ow.wait_for_selector("text=kräver godkännande"); print("skapande begärt (202)")
    sa=b.new_page(viewport={"width":1300,"height":850}); login(sa,"super@example.test"); sa.click("nav a[href='/approvals']")
    sa.wait_for_selector(f"tr:has-text('{email}')"); sa.click(f"tr:has-text('{email}') button:has-text('Godkänn')"); sa.click("div.modal button:has-text('Godkänn')")
    try:
        sa.wait_for_selector("text=Bekräfta din identitet",timeout=2500); sa.fill("input[autocomplete=one-time-code]",totp(S)); sa.click("button:has-text('Bekräfta och utför')")
    except Exception: pass
    sa.wait_for_selector(f"tr:has-text('{email}'):has-text('Utförd')",timeout=6000); print("godkänd och utförd av annan admin")
    time.sleep(17)  # utkorgsarbetaren skriver .eml
    files=sorted(glob.glob("/home/claude/plattform/apps/api/.mail-outbox/*.eml"),key=os.path.getmtime)
    mail=[open(f).read() for f in files if email in open(f).read()][-1]; token=re.search(r"token=([\w-]+)",mail).group(1); print("engångslänk mottagen via e-post")
    nw=b.new_page(viewport={"width":1000,"height":800}); nw.goto(f"http://127.0.0.1:5173/setup?token={token}"); nw.fill("input >> nth=0",PW); nw.fill("input >> nth=1",PW); nw.click("button:has-text('Spara lösenord')"); nw.wait_for_selector("text=Lösenordet är sparat"); print("lösenord valt")
    nw.screenshot(path=SH+"admin-setup.png"); nw.click("text=Fortsätt till inloggning"); nw.fill('input[type=email]',email); nw.fill('input[type=password]',PW); nw.click("text=Fortsätt")
    nw.wait_for_selector("text=Aktivera tvåstegsverifiering"); sec=nw.inner_text("span.mono"); nw.fill("input[autocomplete=one-time-code]",totp(sec)); nw.click("button:has-text('Bekräfta och aktivera')")
    nw.wait_for_selector("text=Spara dina återställningskoder"); nw.click("text=Jag har sparat koderna"); nw.wait_for_selector("h1:has-text('Översikt')"); print("ny admin: MFA registrerad och inloggad")
    print("nav:",[a.inner_text().split("\n")[0] for a in nw.query_selector_all("nav a")])
    # direkt inaktivering: sessioner avslutas
    ow.reload(); ow.wait_for_selector(f"tr:has-text('{email}')"); ow.click(f"tr:has-text('{email}') button:has-text('Inaktivera')"); ow.fill("div.modal textarea","Test av inaktivering, kontot används inte längre")
    ow.click("div.modal button:has-text('Inaktivera')")
    try:
        ow.wait_for_selector("text=Bekräfta din identitet",timeout=2500); ow.fill("input[autocomplete=one-time-code]",totp(S)); ow.click("button:has-text('Bekräfta och utför')")
    except Exception: pass
    ow.wait_for_selector(f"tr:has-text('{email}'):has-text('Inaktiverad')",timeout=6000); print("inaktiverad")
    nw.reload(); nw.wait_for_selector("text=Fortsätt",timeout=6000); print("ny admins session avslutad direkt")
    b.close()
