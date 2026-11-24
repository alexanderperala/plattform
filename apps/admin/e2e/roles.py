import hmac,hashlib,base64,struct,time
from playwright.sync_api import sync_playwright
def totp(s):
    k=base64.b32decode(s); c=int(time.time())//30
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
def login(pg,email):
    pg.goto("http://127.0.0.1:5173/"); pg.fill('input[type=email]',email); pg.fill('input[type=password]',"DevAdminPassword!2026"); pg.click("text=Fortsätt")
    pg.wait_for_selector("text=Tvåstegsverifiering"); pg.fill("input",totp("JBSWY3DPEHPK3PXP")); pg.click("button:has-text('Verifiera')"); pg.wait_for_selector("h1:has-text('Översikt')")
with sync_playwright() as p:
    b=p.chromium.launch()
    pg=b.new_page(); login(pg,"support@example.test")
    print("support nav:",[a.inner_text().split("\n")[0] for a in pg.query_selector_all("nav a")])
    pg.click("nav a[href='/customers']"); pg.wait_for_selector("tbody tr"); pg.click("tbody tr >> nth=0"); pg.wait_for_selector("text=Kunduppgifter")
    print("support knappar:",[x.inner_text() for x in pg.query_selector_all(".page-head button")])
    r=pg.evaluate("""fetch('/api/platform-admin/workspaces/'+location.pathname.split('/').pop()+'/close',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-requested-with':'platform-admin'},body:JSON.stringify({reason:'försök utan behörighet'})}).then(r=>r.status)""")
    print("support close direkt mot API:",r)
    pg2=b.new_page(); login(pg2,"super@example.test")
    pg2.click("nav a[href='/customers']"); pg2.wait_for_selector("tbody tr"); pg2.click("tbody tr >> nth=1"); pg2.wait_for_selector("text=Kunduppgifter")
    pg2.click("button:has-text('Avsluta…')"); pg2.fill("textarea","Four-eyes test via UI, kund begärde avslut"); pg2.click("button:has-text('Begär avslut')")
    try:
        pg2.wait_for_selector("text=Bekräfta din identitet",timeout=3000); print("reauth-dialog visades")
        pg2.fill("input[autocomplete=one-time-code]",totp("JBSWY3DPEHPK3PXP")); pg2.click("button:has-text('Bekräfta och utför')")
    except Exception: print("ingen reauth-dialog")
    pg2.wait_for_selector("text=kräver godkännande",timeout=5000); print("202 approval-toast visades")
    st=pg2.evaluate("fetch('/api/platform-admin/auth/me',{credentials:'same-origin'}).then(r=>r.json())"); 
    pg2.click("nav a[href='/approvals']"); pg2.wait_for_selector("text=Väntar"); print("approval i inkorg:", pg2.query_selector("tbody tr").inner_text().replace("\n"," | ")[:150])
    b.close()
