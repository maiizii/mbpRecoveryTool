from common.mytRpc import MytRpc
api = MytRpc()
print('SDK_VERSION', api.get_sdk_version())
ok = api.init('mylo.gote.top', 23122, 20)
print('INIT_OK', ok)
print('CONNECTED', api.check_connect_state())
if ok:
    out, ok2 = api.exec_cmd('getprop ro.product.model')
    print('EXEC_OK', ok2)
    print('MODEL', str(out).strip())
