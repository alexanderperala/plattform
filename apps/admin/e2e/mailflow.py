import hmac,hashlib,base64,struct,time,json,subprocess,urllib.request,http.cookiejar
def totp(s):
    k=base64.b32decode(s); c=int(time.time())//30
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
cj=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def call(m,path,b=None):
    r=urllib.request.Request("http://127.0.0.1:4000/api/platform-admin"+path,method=m,data=json.dumps(b).encode() if b is not None else None,headers={"content-type":"application/json","x-requested-with":"platform-admin","origin":"http://127.0.0.1:4000"})
    try: return json.load(op.open(r))
    except urllib.error.HTTPError as e: return json.load(e)
call("POST","/auth/login",{"email":"support@example.test","password":"DevAdminPassword!2026"})
print(call("POST","/auth/mfa/verify",{"code":totp("JBSWY3DPEHPK3PXP")}))
c=call("POST","/support/cases",{"subject":"SMTP-test","requesterEmail":"kund@example.test"})
print(call("POST",f"/support/cases/{c['id']}/comments",{"body":"Hej! Vi har tittat på ditt ärende.","internal":False}))
