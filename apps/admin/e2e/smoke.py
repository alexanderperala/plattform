import hmac,hashlib,base64,struct,time,sys
from playwright.sync_api import sync_playwright
def totp(s):
    k=base64.b32decode(s); c=int(time.time())//30
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
SH="/home/claude/plattform/docs/screenshots/"
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1360,"height":850})
    pg.on("console",lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.on("pageerror",lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:5173/")
    pg.fill('input[type=email]',"super@example.test"); pg.fill('input[type=password]',"DevAdminPassword!2026"); pg.click("text=Fortsätt")
    pg.wait_for_selector("text=Tvåstegsverifiering"); pg.fill("input",totp("JBSWY3DPEHPK3PXP")); pg.click("button:has-text('Verifiera')")
    pg.wait_for_selector("h1:has-text('Översikt')"); pg.wait_for_timeout(500); pg.screenshot(path=SH+"dashboard.png")
    for name,path,h in [("customers","/customers","Kunder"),("users","/users","Användare"),("products","/products","Produkter och licenser"),("support","/support","Support"),("approvals","/approvals","Godkännanden"),("audit","/audit","Granskningslogg"),("logs","/logs","Tekniska fel")]:
        pg.click(f"nav a[href='{path}']"); pg.wait_for_selector(f"h1:has-text('{h}')"); pg.wait_for_timeout(500); pg.screenshot(path=SH+name+".png")
        print(name,"ok")
    pg.click("nav a[href='/customers']"); pg.wait_for_selector("tbody tr"); 
    pg.fill("input[type=search]","a"); pg.wait_for_timeout(700)
    pg.click("tbody tr >> nth=0"); pg.wait_for_selector("text=Kunduppgifter"); pg.screenshot(path=SH+"customer-detail.png")
    # verkligt skrivande flöde: pausa arbetsytan med orsak + MFA-omautentisering
    pg.click("button:has-text('Pausa')>>nth=0")
    pg.fill("textarea","Smoketest av pausflödet i UI"); pg.click("button:has-text('Pausa'):not(.small) >> nth=-1")
    try:
        pg.wait_for_selector("text=Bekräfta din identitet",timeout=2500)
        pg.fill("input[autocomplete=one-time-code]",totp("JBSWY3DPEHPK3PXP")); pg.click("button:has-text('Bekräfta och utför')")
    except Exception as e: print("ingen reauth krävdes (färsk session)")
    pg.wait_for_selector("text=Pausad",timeout=5000); print("suspend ok")
    pg.click("button:has-text('Återaktivera')"); pg.fill("textarea","Återställer efter smoketest"); pg.click("button:has-text('Återaktivera'):not(.small) >> nth=-1")
    pg.wait_for_selector("button:has-text('Pausa')",timeout=5000); print("reactivate ok")
    pg.set_viewport_size({"width":390,"height":800}); pg.goto("http://127.0.0.1:5173/customers"); pg.wait_for_selector("tbody tr"); pg.screenshot(path=SH+"customers-mobile.png")
    pg.click("text=☰ Meny"); pg.wait_for_selector("nav a"); pg.screenshot(path=SH+"menu-mobile.png")
    b.close()
print("console errors:",errs)
